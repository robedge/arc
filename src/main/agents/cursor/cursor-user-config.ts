import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Read-only look at the user's own Cursor permission and hook files, to tell Settings which of them
 * can still skip Arc's approvals (tech spec 2.4, layer 3). Arc never writes any of these files.
 * - `~/.cursor/cli-config.json` and a project's `.cursor/cli.json`: `permissions.allow` and
 *   `approvalMode`;
 * - `~/.cursor/hooks.json` and a project's `.cursor/hooks.json`: the events that have hooks.
 * Only entry texts and event names are returned, never the contents of a hook.
 */

/** Allow-entry kinds that skip a prompt Arc would otherwise answer. Reads and fetches are not gated by Arc. */
const SKIPPING_KINDS = ['Shell', 'Write', 'Mcp']

/** Hook events whose hooks can answer "allow" for a command, an MCP call or any tool. */
export const ALLOW_CAPABLE_CURSOR_HOOKS: readonly string[] = [
  'beforeShellExecution',
  'beforeMCPExecution',
  'preToolUse'
]

export interface CursorPermissionFile {
  allow: string[]
  deny: string[]
  /** The file's `approvalMode`, when it names one. */
  approvalMode?: string
}

export interface CursorUserConfig {
  /** `Shell(...)`, `Write(...)` and `Mcp(...)` allow entries of the user's and the projects' files. */
  allowEntries: string[]
  /** An `approvalMode` other than `allowlist`, when any file sets one. */
  approvalMode?: string
  /** Allow-capable hook events found in the user's and the projects' `hooks.json`. */
  hookEvents: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** `permissions.allow`, `permissions.deny` and `approvalMode` of a `cli-config.json` / `cli.json`. */
export async function readCursorPermissionFile(
  path: string
): Promise<CursorPermissionFile | undefined> {
  const file = await readJson(path)
  if (!isRecord(file)) return undefined
  const permissions = isRecord(file['permissions']) ? file['permissions'] : {}
  const mode = file['approvalMode']
  return {
    allow: strings(permissions['allow']),
    deny: strings(permissions['deny']),
    ...(typeof mode === 'string' && mode !== '' ? { approvalMode: mode } : {})
  }
}

/** The events of a `hooks.json` that have at least one hook (`{ hooks: { event: [ ... ] } }`). */
export async function readCursorHookEvents(path: string): Promise<string[]> {
  const file = await readJson(path)
  const hooks = isRecord(file) && isRecord(file['hooks']) ? file['hooks'] : {}
  return Object.entries(hooks)
    .filter(([, list]) => Array.isArray(list) && list.length > 0)
    .map(([event]) => event)
}

function skipsPrompts(entry: string): boolean {
  return SKIPPING_KINDS.some((kind) => entry.startsWith(`${kind}(`))
}

/**
 * What in the user's Cursor setup can answer "allow" without Arc: the home files, plus the project
 * files of the given repositories. A file that is missing or unreadable adds nothing.
 */
export async function readCursorUserConfig(
  home: string,
  repoPaths: readonly string[] = []
): Promise<CursorUserConfig> {
  const dirs = [join(home, '.cursor')]
  const cli = [join(home, '.cursor', 'cli-config.json')]
  const hooks = [join(home, '.cursor', 'hooks.json')]
  for (const repo of repoPaths) {
    cli.push(join(repo, '.cursor', 'cli.json'))
    hooks.push(join(repo, '.cursor', 'hooks.json'))
    dirs.push(join(repo, '.cursor'))
  }
  const [permissionFiles, hookLists] = await Promise.all([
    Promise.all(cli.map(readCursorPermissionFile)),
    Promise.all(hooks.map(readCursorHookEvents))
  ])
  const allowEntries = new Set<string>()
  let approvalMode: string | undefined
  for (const file of permissionFiles) {
    if (!file) continue
    for (const entry of file.allow) if (skipsPrompts(entry)) allowEntries.add(entry)
    if (file.approvalMode !== undefined && file.approvalMode !== 'allowlist') {
      approvalMode ??= file.approvalMode
    }
  }
  const found = new Set(hookLists.flat())
  return {
    allowEntries: [...allowEntries],
    ...(approvalMode === undefined ? {} : { approvalMode }),
    hookEvents: ALLOW_CAPABLE_CURSOR_HOOKS.filter((event) => found.has(event))
  }
}
