import type { CommandInfo } from '@shared/types/commands'
import { PROVIDER_IDS, type ProviderId } from '@shared/types/provider'

/** The id prefixes a command can carry (`codex:review`), as a regex group. */
export const COMMAND_ID_PREFIX = PROVIDER_IDS.join('|')

/** The command name a message starts with: "/awos:spec retry" gives "awos:spec". */
export function commandNameOf(text: string): string | null {
  const match = /^\/(\S+)/.exec(text)
  return match?.[1] ?? null
}

/** A command as the brain or a plan writes it: `/name args`, or `claude:name args` / `codex:name args` / `cursor:name args`. */
export interface CommandRef {
  /** What follows the slash, or the whole first word when there is no slash. */
  ref: string
  slashed: boolean
  args: string
}

export function splitCommandRef(text: string): CommandRef | null {
  const match = /^(\/?)(\S+)([\s\S]*)$/.exec(text.trim())
  if (!match?.[2]) return null
  const slashed = match[1] === '/'
  // Without a slash only an id (`codex:review`) is a command.
  if (!slashed && !new RegExp(`^(?:${COMMAND_ID_PREFIX}):\\S`).test(match[2])) return null
  return { ref: match[2], slashed, args: (match[3] ?? '').trim() }
}

export type CommandMatch =
  | {
      ok: true
      name: string
      /** The one provider whose worker runs it. */
      provider: ProviderId
      /** The entries of that provider with this name. */
      entries: CommandInfo[]
      /** `/name args`, whichever way it was written: what the worker is sent and labelled with. */
      text: string
    }
  | { ok: false; reason: 'unknown' | 'ambiguous'; name: string; ids: string[] }

/**
 * Finds the catalogue entries a command names. `/name` matches by name; `codex:name` and
 * `claude:name` match by id (a `/` form that names no entry falls back to the id, so a Claude
 * plugin called `codex` still works). A name that both providers have is ambiguous and lists both ids.
 */
export function matchCommand(text: string, entries: readonly CommandInfo[]): CommandMatch {
  const parsed = splitCommandRef(text)
  const ref = parsed?.ref ?? ''
  let matching = parsed?.slashed ? entries.filter((c) => c.name === ref) : []
  if (matching.length === 0) matching = entries.filter((c) => c.id === ref)
  const first = matching[0]
  if (!parsed || !first) return { ok: false, reason: 'unknown', name: ref, ids: [] }
  const ids = [...new Set(matching.map((c) => c.id))].sort()
  if (new Set(matching.map((c) => c.provider)).size > 1) {
    return { ok: false, reason: 'ambiguous', name: first.name, ids }
  }
  return {
    ok: true,
    name: first.name,
    provider: first.provider,
    entries: matching,
    text: parsed.args === '' ? `/${first.name}` : `/${first.name} ${parsed.args}`
  }
}

/** The repositories that save this command, from the catalogue entries named like it. */
export function reposWithCommand(entries: readonly CommandInfo[]): string[] {
  return entries.filter((c) => c.source.startsWith('repo:')).map((c) => c.source.slice(5))
}

/**
 * A command is available in a repository when it comes from the user or a plugin (it works
 * anywhere), or when that repository saves it.
 */
export function isCommandAvailable(entries: readonly CommandInfo[], projectName: string): boolean {
  const wanted = projectName.toLowerCase()
  return entries.some(
    (c) => !c.source.startsWith('repo:') || c.source.slice(5).toLowerCase() === wanted
  )
}

/** What the brain is told when the user's message is a command of the catalogue (tech spec 2.4). */
export function commandInstruction(
  text: string,
  name: string,
  entries: readonly CommandInfo[]
): string {
  const args = text.slice(name.length + 1).trim()
  const parts = [
    `[Arc] The user ran the command /${name} with arguments ${JSON.stringify(args)}.`,
    `Start one worker with spawn_worker(command: ${JSON.stringify(text.trim())}).`,
    'Choose the repository from the request; if it is unclear, call ask_user with the repository names as choices (the choices argument).'
  ]
  if (entries.every((c) => c.source.startsWith('repo:'))) {
    const repos = reposWithCommand(entries)
    parts.push(
      `This command is saved only in ${repos.length === 1 ? 'the repository' : 'the repositories'}: ${repos.join(', ')}. Choose among those.`
    )
  }
  return parts.join(' ')
}

/** What the brain is told when the user's command exists for both providers. */
export function ambiguousCommandInstruction(text: string, ids: readonly string[]): string {
  const args = splitCommandRef(text)?.args ?? ''
  return [
    `[Arc] The user ran ${JSON.stringify(text.trim())}, but that name exists for both providers (${ids.join(' and ')}).`,
    'Call ask_user to ask which one they mean, with the ids as the choices.',
    `Then start one worker with spawn_worker(command: "<chosen id>${args === '' ? '' : ` ${args}`}").`
  ].join(' ')
}
