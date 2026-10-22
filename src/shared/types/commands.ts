import type { ProviderId } from './provider'

/**
 * Where a command in the `/` list comes from: the user's own commands and skills (`user`), a plugin
 * of the current plugin view (`plugin:<name>`), a repository's saved commands (`repo:<project>`),
 * the user's Codex skills and saved prompts (`codex`), or the Cursor commands and skills
 * of the user and the projects (`cursor`).
 */
export type CommandSource = 'user' | `plugin:${string}` | `repo:${string}` | 'codex' | 'cursor'

/** What a command is: a Claude Code command, a Codex skill or saved prompt, or a Cursor command or skill. */
export type CommandKind = 'command' | 'skill' | 'prompt'

/** One entry of a session's command catalogue (spec 005, extended for Codex by spec 007). */
export interface CommandInfo {
  /** `${provider}:${name}`: tells apart a `/review` that both providers have. */
  id: string
  /** Without the leading slash, as the CLI names it: `awos:spec`, `user:agent-browser`, `fix-lint`. */
  name: string
  description: string
  argumentHint?: string
  source: CommandSource
  /** The provider whose worker runs the command. */
  provider: ProviderId
  kind: CommandKind
}

/** The id of a command: `claude:review`, `codex:publish-release`. */
export function commandId(provider: ProviderId, name: string): string {
  return `${provider}:${name}`
}
