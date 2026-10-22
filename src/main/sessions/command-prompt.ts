import { assertNever } from '@shared/assert-never'
import type { CommandInfo, CommandSource } from '@shared/types/commands'

/** Most entries listed in the brain's prompt. */
export const PROMPT_COMMAND_LIMIT = 40
const DESCRIPTION_MAX = 80

/** What the brain does with the list (tech spec 2.4, brain-started commands). */
export const COMMANDS_GUIDANCE =
  'When the user asks for something one of these commands does well, use the command: start a worker with spawn_worker(command: "/name arguments") (in Plan-first, list it in the plan with the command). Name the command and give the reason in one sentence. Each command runs on the provider shown in its brackets, whatever the Workers setting says. If a name is listed for both providers, pass codex:name or claude:name. Only use commands from this list.'

/** Shown instead of the list when the catalogue could not be read at launch. */
export const COMMANDS_UNAVAILABLE =
  'The command list is not available right now. You can list commands later, once it arrives with your next restart.'

function sourceLabel(source: CommandSource): string {
  if (source === 'user') return 'yours'
  if (source.startsWith('plugin:')) return `plugin ${source.slice('plugin:'.length)}`
  return `repo ${source.slice('repo:'.length)}`
}

/** Which provider runs the command, and what it is: `Claude, plugin x` or `Codex skill`. */
function providerTag(command: CommandInfo): string {
  switch (command.provider) {
    case 'claude':
      return `Claude, ${sourceLabel(command.source)}`
    case 'codex':
      return `Codex ${command.kind === 'prompt' ? 'prompt' : 'skill'}`
    case 'cursor':
      return `Cursor ${command.kind === 'skill' ? 'skill' : 'command'}`
    default:
      return assertNever(command.provider)
  }
}

function clip(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim()
  return flat.length <= DESCRIPTION_MAX ? flat : `${flat.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
}

/** One line per command: `- /name (Codex skill) – description`. */
export function commandLine(command: CommandInfo): string {
  const description = clip(command.description)
  return `- /${command.name} (${providerTag(command)})${description === '' ? '' : ` – ${description}`}`
}

/** The "Commands available" lines (up to 40), or undefined when there is nothing to list. */
export function commandsBlock(commands: readonly CommandInfo[]): string | undefined {
  if (commands.length === 0) return undefined
  const shown = commands.slice(0, PROMPT_COMMAND_LIMIT)
  const more = commands.length - shown.length
  return [
    'Commands available:',
    ...shown.map(commandLine),
    ...(more > 0 ? [`(and ${more} more that the user can pick by typing /)`] : [])
  ].join('\n')
}

/** The whole prompt section: the list and the guidance, or the unavailable line. */
export function commandsSection(commands: readonly CommandInfo[] | null): string {
  const block = commands ? commandsBlock(commands) : undefined
  return block ? `${block}\n${COMMANDS_GUIDANCE}` : COMMANDS_UNAVAILABLE
}
