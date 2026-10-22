import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandId, type CommandInfo } from '../../../shared/types/commands'
import type { ProviderStatusMap } from '../../../shared/types/provider'
import { expandCodexPrompt, parsePromptFile } from '../codex/codex-commands'
import type { CursorCommand } from './cursor-types'

/**
 * The user's and the projects' Cursor commands and skills as `/` list entries (tech spec 2.9).
 *
 * The entries come from Cursor's own folders, read-only: `commands/*.md` and `skills/<name>/SKILL.md`
 * under `~/.cursor` and `<repo>/.cursor`. Cursor's `available_commands_update` (kept by `CursorProbe`)
 * fills in the descriptions. It also lists the Claude and Codex skills Cursor loads, and Cursor's own
 * built-ins; none of those has a Cursor-owned file, so they are dropped here (Arc lists the Claude and
 * Codex ones under their own providers).
 *
 * Running: Arc expands the command itself (`resolve`). Spike M5 showed that a bare `/shout banana`
 * prompt runs the command file, but Arc's `<arc-instructions>` block is prefixed to a worker's first
 * prompt, so the slash would no longer start the text; the user decided (2026-10-21) not to rely on
 * Cursor parsing it. The first message is the file's body with the arguments applied, as for Codex prompts.
 */

/** How long the files are reused before the next `/` request reads them again. */
export const CURSOR_COMMANDS_TTL_MS = 60_000

/** The `(user)`, `(global)` or `(project)` Cursor appends to a description in its list. */
const SOURCE_SUFFIX = /\s*\((?:user|global|project)\)\s*$/

/** What a Cursor-owned file declares. */
interface CursorFile {
  name: string
  kind: 'command' | 'skill'
  description: string
  argumentHint?: string
  /** The Cursor-owned file (`commands/<name>.md` or `skills/<dir>/SKILL.md`). */
  path: string
}

/** What running a Cursor command sends as the worker's first message. */
export type CursorInvocation =
  | { ok: true; text: string }
  | {
      ok: false
      code: 'unknown_command' | 'command_unreadable' | 'command_args_invalid'
      message: string
    }

/** What the worker manager needs from `CursorCommands`. */
export interface CursorCommandRunner {
  resolve(name: string, args: string, cwds: readonly string[]): Promise<CursorInvocation>
}

/** A `$1`, `$ARGUMENTS` or `$KEY` in a command body: the arguments go there instead of at the end. */
const HAS_PLACEHOLDER = /\$(?:[1-9]|[A-Z][A-Z0-9_]*)/

/** The body of a command or skill file: front matter stripped. */
function bodyOf(name: string, text: string): string {
  return parsePromptFile(name, text).body
}

/** The command `description` when the file has none: its first non-empty body line. */
function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/^#+\s*/, '').trim()
    if (text !== '') return text
  }
  return ''
}

function fileEntry(
  name: string,
  kind: CursorFile['kind'],
  text: string,
  path: string,
  keepName = false
): CursorFile {
  const parsed = parsePromptFile(name, text)
  return {
    name: keepName ? name : parsed.name,
    kind,
    path,
    description: parsed.description !== '' ? parsed.description : firstLine(parsed.body),
    ...(parsed.argumentHint !== undefined ? { argumentHint: parsed.argumentHint } : {})
  }
}

/** `*.md` files of a commands folder; a missing folder or an unreadable file is simply no command. */
async function readCommandsDir(dir: string): Promise<CursorFile[]> {
  let names: string[]
  try {
    names = (await readdir(dir, { withFileTypes: true }))
      .filter(
        (e) => (e.isFile() || e.isSymbolicLink()) && e.name.endsWith('.md') && e.name.length > 3
      )
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
  const out: CursorFile[] = []
  for (const file of names) {
    try {
      const path = join(dir, file)
      out.push(fileEntry(file.slice(0, -3), 'command', await readFile(path, 'utf8'), path))
    } catch {
      // Skipped: the list never fails because of one file.
    }
  }
  return out
}

/** `<name>/SKILL.md` of a skills folder (a symlinked folder counts); the folder name is the skill's name. */
async function readSkillsDir(dir: string): Promise<CursorFile[]> {
  let names: string[]
  try {
    names = (await readdir(dir)).sort()
  } catch {
    return []
  }
  const out: CursorFile[] = []
  for (const folder of names) {
    try {
      if (!(await stat(join(dir, folder))).isDirectory()) continue
      const path = join(dir, folder, 'SKILL.md')
      const text = await readFile(path, 'utf8')
      // The skill is called by its folder; `name:` in the front matter is not what Cursor lists.
      out.push(fileEntry(folder, 'skill', text, path, true))
    } catch {
      // No SKILL.md or unreadable: not a skill.
    }
  }
  return out
}

export interface CursorCommandsDeps {
  /** `CursorProbe`: the commands its last `session/new` listed. */
  probe: { lastCommands: () => readonly CursorCommand[] }
  /** The provider status; Cursor entries exist only while Cursor is `ok`. */
  status: () => ProviderStatusMap
  /** The user's home folder (tests). */
  home?: () => string
  now?: () => number
  ttlMs?: number
}

/** The user's and projects' Cursor commands and skills, cached for a minute. */
export class CursorCommands implements CursorCommandRunner {
  private readonly cache = new Map<string, { at: number; files: CursorFile[] }>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: CursorCommandsDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? CURSOR_COMMANDS_TTL_MS
  }

  /** Empty while Cursor is not `ok`. A project's file wins over the user's of the same name. */
  async list(cwds: readonly string[], refresh = false): Promise<CommandInfo[]> {
    if (this.deps.status().cursor?.state !== 'ok') return []
    const files = await this.load(cwds, refresh)
    const listed = new Map(this.deps.probe.lastCommands().map((c) => [c.name, c.description]))
    const seen = new Set<string>()
    const entries: CommandInfo[] = []
    for (const file of files) {
      if (seen.has(file.name)) continue
      seen.add(file.name)
      const fromCursor = listed.get(file.name)?.replace(SOURCE_SUFFIX, '').trim()
      entries.push({
        id: commandId('cursor', file.name),
        name: file.name,
        description: fromCursor !== undefined && fromCursor !== '' ? fromCursor : file.description,
        ...(file.argumentHint !== undefined ? { argumentHint: file.argumentHint } : {}),
        source: 'cursor',
        provider: 'cursor',
        kind: file.kind
      })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * The first message of a Cursor command worker: its file's body (front matter stripped) with the
   * arguments applied, under a line that names the command. The file is read again now; one that can
   * no longer be read is an error, never a bare `/name`.
   */
  async resolve(name: string, args: string, cwds: readonly string[]): Promise<CursorInvocation> {
    const file = (await this.load(cwds, false)).find((f) => f.name === name)
    if (file === undefined) {
      return {
        ok: false,
        code: 'unknown_command',
        message: `/${name} is not a Cursor command or skill.`
      }
    }
    let body: string
    try {
      body = bodyOf(file.name, await readFile(file.path, 'utf8'))
    } catch {
      return {
        ok: false,
        code: 'command_unreadable',
        message: `Arc could not read ${file.path} to run /${name}, so the worker was not started.`
      }
    }
    const expanded = expandCodexPrompt(body, args)
    if (!expanded.ok) {
      const hint = file.argumentHint !== undefined ? ` (${file.argumentHint})` : ''
      return {
        ok: false,
        code: 'command_args_invalid',
        message: `/${name} needs ${expanded.missing.map((k) => `${k}=value`).join(', ')}${hint}. Run it again with ${expanded.missing.length === 1 ? 'that argument' : 'those arguments'}.`
      }
    }
    const trimmed = args.trim()
    const applied =
      trimmed !== '' && !HAS_PLACEHOLDER.test(body)
        ? `${expanded.text.trimEnd()}\n\nArguments: ${trimmed}`
        : expanded.text
    return { ok: true, text: `Running the Cursor command /${name}.\n\n${applied}` }
  }

  /** Drops the cached files (Check again, app start). */
  invalidate(): void {
    this.cache.clear()
  }

  private async load(cwds: readonly string[], refresh: boolean): Promise<CursorFile[]> {
    const key = [...cwds].sort().join('\u0000')
    const cached = this.cache.get(key)
    if (!refresh && cached && this.now() - cached.at < this.ttlMs) return cached.files
    const home = join(this.deps.home?.() ?? homedir(), '.cursor')
    // Repositories first so that a project's file wins over the user's.
    const roots = [...cwds.map((c) => join(c, '.cursor')), home]
    const files: CursorFile[] = []
    for (const root of roots) {
      files.push(
        ...(await readCommandsDir(join(root, 'commands'))),
        ...(await readSkillsDir(join(root, 'skills')))
      )
    }
    this.cache.set(key, { at: this.now(), files })
    return files
  }
}
