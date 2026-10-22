import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Read-only look at the user's Cursor MCP server files (tech spec 2.5): `~/.cursor/mcp.json` and a
 * project's `.cursor/mcp.json`, both `{ "mcpServers": { "<name>": { ... } } }`. Arc never writes
 * either file. A project entry wins a name clash, as it does in Cursor.
 */

/** A server as the file defines it. Held in memory only to ask the server for its tools; never listed or logged. */
export type CursorMcpSpec =
  | { type: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> }

export interface CursorMcpServer {
  name: string
  spec: CursorMcpSpec | undefined
  /** Where it comes from: "Your Cursor servers" or ".cursor/mcp.json in api". */
  source: string
}

export interface CursorMcpRead {
  servers: CursorMcpServer[]
  /** True when a file exists but is not valid JSON of the expected shape. */
  unreadable: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function specOf(value: unknown): CursorMcpSpec | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value['url'] === 'string' && value['url'] !== '') {
    return { type: 'http', url: value['url'], headers: stringMap(value['headers']) }
  }
  if (typeof value['command'] === 'string' && value['command'] !== '') {
    const args = Array.isArray(value['args'])
      ? value['args'].filter((a): a is string => typeof a === 'string')
      : []
    return { type: 'stdio', command: value['command'], args, env: stringMap(value['env']) }
  }
  return undefined
}

type FileRead = { found: false } | { found: true; servers: Record<string, unknown> | undefined }

async function readServers(path: string): Promise<FileRead> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { found: false }
  }
  try {
    const file = JSON.parse(text) as unknown
    if (!isRecord(file)) return { found: true, servers: undefined }
    if (file['mcpServers'] === undefined) return { found: true, servers: {} }
    return { found: true, servers: isRecord(file['mcpServers']) ? file['mcpServers'] : undefined }
  } catch {
    return { found: true, servers: undefined }
  }
}

/**
 * The user's Cursor MCP servers: the home file first, then each folder's `.cursor/mcp.json` (a later
 * file overrides a name from an earlier one). A missing file adds nothing; a broken one sets `unreadable`.
 */
export async function readCursorMcpServers(
  home: string,
  folders: readonly string[] = []
): Promise<CursorMcpRead> {
  const files: { path: string; source: string }[] = [
    { path: join(home, '.cursor', 'mcp.json'), source: 'Your Cursor servers' }
  ]
  for (const folder of folders) {
    files.push({
      path: join(folder, '.cursor', 'mcp.json'),
      source: `.cursor/mcp.json in ${basename(folder)}`
    })
  }
  const found = new Map<string, CursorMcpServer>()
  let unreadable = false
  for (const file of files) {
    const read = await readServers(file.path)
    if (!read.found) continue
    if (read.servers === undefined) {
      unreadable = true
      continue
    }
    for (const [name, value] of Object.entries(read.servers)) {
      found.set(name, { name, spec: specOf(value), source: file.source })
    }
  }
  return {
    servers: [...found.values()].sort((a, b) => a.name.localeCompare(b.name)),
    unreadable
  }
}
