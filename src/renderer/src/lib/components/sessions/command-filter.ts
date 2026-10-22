import type { CommandInfo } from '@shared/types/commands'

function byName(a: CommandInfo, b: CommandInfo): number {
  return a.name.localeCompare(b.name)
}

/**
 * The commands matching what follows the `/` in the message box: name-prefix matches first, then
 * names or descriptions containing the query; case-insensitive, alphabetical within each group.
 * An empty query lists everything.
 */
export function filterCommands(commands: readonly CommandInfo[], query: string): CommandInfo[] {
  const q = query.trim().toLowerCase()
  if (q === '') return [...commands].sort(byName)
  const prefix: CommandInfo[] = []
  const substring: CommandInfo[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(command)
    else if (name.includes(q) || command.description.toLowerCase().includes(q)) {
      substring.push(command)
    }
  }
  return [...prefix.sort(byName), ...substring.sort(byName)]
}

/** The DOM id of option `index` in the menu `menuId`; the textarea's aria-activedescendant points at it. */
export function commandOptionId(menuId: string, index: number): string {
  return `${menuId}-option-${index}`
}
