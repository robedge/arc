import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandId, type CommandInfo } from '../../../shared/types/commands'
import type { ProviderStatusMap } from '../../../shared/types/provider'
import type { CodexSkillInfo, CodexSkillSource } from './codex-probe'
import type { CodexInput } from './codex-types'
import { expandPromptBody, parsePromptFile, type PromptFile } from '../prompt-files'

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

export type CodexPrompt = PromptFile

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
    const expanded = expandPromptBody(prompt.body, args)
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
