import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandId, type CommandInfo } from '../../../shared/types/commands'
import type { ProviderStatusMap } from '../../../shared/types/provider'
import type { CodexSkillInfo, CodexSkillSource } from './codex-probe'
import type { CodexInput } from './codex-types'

/**
 * The user's Codex skills and saved prompts as `/` list entries (tech spec 2.7).
 *
 * Skills come from `skills/list` (no model call) and run as a `skill` turn input. Prompts are the
 * top-level `$CODEX_HOME/prompts/*.md` files: Codex only runs them from its interactive
 * `/prompts:name`, so Arc reads and expands them itself and sends plain text. The prompts folder is
 * only ever read.
 */

/** How long a list is reused before the next `/` request reads it again. */
export const CODEX_COMMANDS_TTL_MS = 60_000

/** `$CODEX_HOME` when the user sets it, else `~/.codex`. */
export function codexHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['CODEX_HOME']
  return home !== undefined && home !== '' ? home : join(homedir(), '.codex')
}

// ---- prompts ------------------------------------------------------------------------------

export interface CodexPrompt {
  /** The file name without `.md`: the name after the slash. */
  name: string
  description: string
  argumentHint?: string
  body: string
}

function unquote(value: string): string {
  const v = value.trim()
  const quote = v[0]
  return v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote) ? v.slice(1, -1) : v
}

/** Splits optional `---` front matter off a prompt file; reads its `description` and `argument-hint`. */
export function parsePromptFile(
  name: string,
  text: string
): Omit<CodexPrompt, 'name'> & { name: string } {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalized)
  let description = ''
  let argumentHint: string | undefined
  let body = normalized
  if (match) {
    body = normalized.slice(match[0].length)
    for (const line of (match[1] ?? '').split('\n')) {
      const colon = line.indexOf(':')
      if (colon === -1) continue
      const key = line.slice(0, colon).trim()
      const value = unquote(line.slice(colon + 1))
      if (key === 'description') description = value
      else if (key === 'argument-hint' && value !== '') argumentHint = value
    }
  }
  return { name, description, ...(argumentHint !== undefined ? { argumentHint } : {}), body }
}

/** Reads the prompts folder; a missing folder or an unreadable file is simply no prompt. */
export async function readCodexPrompts(codexHome: string): Promise<CodexPrompt[]> {
  const dir = join(codexHome, 'prompts')
  let entries: string[]
  try {
    entries = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name.length > 3)
      .map((e) => e.name)
  } catch {
    return []
  }
  const prompts: CodexPrompt[] = []
  for (const file of entries.sort()) {
    try {
      prompts.push(parsePromptFile(file.slice(0, -3), await readFile(join(dir, file), 'utf8')))
    } catch {
      // Skipped: the list never fails because of one file.
    }
  }
  return prompts
}

/** Splits an argument string on whitespace; single or double quotes keep words together. */
export function splitArgs(argString: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (const ch of argString) {
    if (quote !== null) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current !== '') tokens.push(current)
      current = ''
      started = false
    } else {
      current += ch
    }
  }
  if (started || current !== '') tokens.push(current)
  return tokens
}

export type PromptExpansion = { ok: true; text: string } | { ok: false; missing: string[] }

const NAMED_ARG = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/

/**
 * Expands a prompt body the way Codex does: `$1`..`$9` are the positional arguments (empty when
 * absent), `$ARGUMENTS` is all of them joined by spaces, `$KEY` takes the `KEY=value` argument, and
 * `$$` is a literal `$`. A named placeholder with no value is an error: the caller gets the names
 * that are missing instead of a half-expanded prompt.
 */
export function expandCodexPrompt(body: string, argString: string): PromptExpansion {
  const positional: string[] = []
  const named = new Map<string, string>()
  for (const token of splitArgs(argString)) {
    const pair = NAMED_ARG.exec(token)
    if (pair?.[1] !== undefined) named.set(pair[1], pair[2] ?? '')
    else positional.push(token)
  }
  const missing: string[] = []
  const text = body.replace(
    /\$(?:(\$)|([1-9])|([A-Z][A-Z0-9_]*))/g,
    (_all, dollar?: string, digit?: string, key?: string) => {
      if (dollar !== undefined) return '$'
      if (digit !== undefined) return positional[Number(digit) - 1] ?? ''
      if (key === 'ARGUMENTS') return positional.join(' ')
      const value = key === undefined ? undefined : named.get(key)
      if (value === undefined) {
        if (key !== undefined && !missing.includes(key)) missing.push(key)
        return ''
      }
      return value
    }
  )
  return missing.length > 0 ? { ok: false, missing } : { ok: true, text }
}

// ---- the list and the invocation -------------------------------------------------------------

export interface CodexCommandsDeps {
  skills: CodexSkillSource
  /** The provider status; Codex entries exist only while Codex is `ok`. */
  status: () => ProviderStatusMap
  /** `$CODEX_HOME` (the user's env var, else `~/.codex`). */
  codexHome?: () => string
  now?: () => number
  ttlMs?: number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/** What running a Codex command sends as the worker's first message. */
export type CodexInvocation =
  | { ok: true; kind: 'skill'; input: CodexInput[] }
  | { ok: true; kind: 'prompt'; text: string }
  | { ok: false; code: 'unknown_command' | 'command_args_invalid'; message: string }

/** What the orchestrator and the worker manager need from `CodexCommands`. */
export interface CodexCommandRunner {
  resolve(name: string, args: string, cwds: readonly string[]): Promise<CodexInvocation>
  findSkill(name: string, cwds: readonly string[]): Promise<CodexSkillInfo | undefined>
}

interface Loaded {
  at: number
  skills: CodexSkillInfo[]
  prompts: CodexPrompt[]
}

/** The user's Codex skills and saved prompts, cached for a minute. */
export class CodexCommands implements CodexCommandRunner {
  private readonly cache = new Map<string, Loaded>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: CodexCommandsDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? CODEX_COMMANDS_TTL_MS
  }

  /** Empty while Codex is not `ok`; a skill list that cannot be read leaves the prompts. */
  async list(cwds: readonly string[], refresh = false): Promise<CommandInfo[]> {
    if (this.deps.status().codex?.state !== 'ok') return []
    const { skills, prompts } = await this.load(cwds, refresh)
    const entries: CommandInfo[] = skills.map((s) => ({
      id: commandId('codex', s.name),
      name: s.name,
      description: s.description,
      source: 'codex',
      provider: 'codex',
      kind: 'skill'
    }))
    const taken = new Set(skills.map((s) => s.name))
    for (const p of prompts) {
      if (taken.has(p.name)) continue
      entries.push({
        id: commandId('codex', p.name),
        name: p.name,
        description: p.description,
        ...(p.argumentHint !== undefined ? { argumentHint: p.argumentHint } : {}),
        source: 'codex',
        provider: 'codex',
        kind: 'prompt'
      })
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** A skill by name from what is cached or listed now; used for a `/skill` typed in step-in. */
  async findSkill(name: string, cwds: readonly string[]): Promise<CodexSkillInfo | undefined> {
    if (this.deps.status().codex?.state !== 'ok') return undefined
    return (await this.load(cwds, false)).skills.find((s) => s.name === name)
  }

  /** The skill input or the expanded prompt for `/name args`; an error when it cannot be run. */
  async resolve(name: string, args: string, cwds: readonly string[]): Promise<CodexInvocation> {
    const { skills, prompts } = await this.load(cwds, false)
    const skill = skills.find((s) => s.name === name)
    if (skill) {
      return {
        ok: true,
        kind: 'skill',
        input: [
          { type: 'skill', name: skill.name, path: skill.path },
          { type: 'text', text: args }
        ]
      }
    }
    const prompt = prompts.find((p) => p.name === name)
    if (!prompt) {
      return {
        ok: false,
        code: 'unknown_command',
        message: `/${name} is not a Codex skill or saved prompt.`
      }
    }
    const expanded = expandCodexPrompt(prompt.body, args)
    if (!expanded.ok) {
      const hint = prompt.argumentHint !== undefined ? ` (${prompt.argumentHint})` : ''
      return {
        ok: false,
        code: 'command_args_invalid',
        message: `/${name} needs ${expanded.missing.map((k) => `${k}=value`).join(', ')}${hint}. Run it again with ${expanded.missing.length === 1 ? 'that argument' : 'those arguments'}.`
      }
    }
    return { ok: true, kind: 'prompt', text: expanded.text }
  }

  /** Drops the cached lists (Check again, app start). */
  invalidate(): void {
    this.cache.clear()
  }

  private async load(cwds: readonly string[], refresh: boolean): Promise<Loaded> {
    const key = [...cwds].sort().join('\u0000')
    const cached = this.cache.get(key)
    if (!refresh && cached && this.now() - cached.at < this.ttlMs) return cached
    const home = this.deps.codexHome?.() ?? codexHomeOf()
    const [skills, prompts] = await Promise.all([
      this.deps.skills.listSkills(cwds).catch((error: unknown) => {
        this.deps.log?.warn('could not list the Codex skills', error)
        return cached?.skills ?? []
      }),
      readCodexPrompts(home)
    ])
    const loaded: Loaded = { at: this.now(), skills, prompts }
    this.cache.set(key, loaded)
    return loaded
  }
}
