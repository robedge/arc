import type { McpServerTools, McpToolInfo } from './agent-adapter'

/**
 * What a running agent says about its MCP servers, reduced to what Arc decides on: which tools
 * are read-only and which are destructive (spec 007 section 2.6). Nothing else of the answer is kept:
 * server entries can carry URLs and tokens.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Claude's `control_request` `mcp_status` answer (spike S8, checked for `destructive`):
 * `{ mcpServers: [{ name, status, tools: [{ name, annotations: { readOnly?, destructive?, openWorld? } }] }] }`.
 * The CLI writes a hint into `annotations` only when it is true, so a missing key means "not true".
 */
export function parseClaudeMcpStatus(response: unknown): McpServerTools[] {
  const servers = isRecord(response) ? response['mcpServers'] : undefined
  if (!Array.isArray(servers)) return []
  const out: McpServerTools[] = []
  for (const server of servers as unknown[]) {
    if (!isRecord(server) || typeof server['name'] !== 'string') continue
    const tools: McpToolInfo[] = []
    const listed = server['tools']
    if (Array.isArray(listed)) {
      for (const tool of listed as unknown[]) {
        if (!isRecord(tool) || typeof tool['name'] !== 'string') continue
        const annotations = isRecord(tool['annotations']) ? tool['annotations'] : {}
        tools.push({
          name: tool['name'],
          readOnly: annotations['readOnly'] === true,
          destructive: annotations['destructive'] === true
        })
      }
    }
    out.push({ name: server['name'], connected: server['status'] === 'connected', tools })
  }
  return out
}

/**
 * One page of Codex's `mcpServerStatus/list` (`{ data: [{ name, runtimeStatus, tools: { <name>: { annotations } } }] }`).
 * The annotations are the MCP spec's own: `readOnlyHint` and `destructiveHint`. `runtimeStatus`
 * is null for a server the thread has not started; its listed tools are still usable.
 */
export function parseCodexMcpStatus(response: unknown): McpServerTools[] {
  const data = isRecord(response) ? response['data'] : undefined
  if (!Array.isArray(data)) return []
  const out: McpServerTools[] = []
  for (const server of data as unknown[]) {
    if (!isRecord(server) || typeof server['name'] !== 'string') continue
    const tools: McpToolInfo[] = []
    const listed = server['tools']
    if (isRecord(listed)) {
      for (const [key, tool] of Object.entries(listed)) {
        if (!isRecord(tool)) continue
        const annotations = isRecord(tool['annotations']) ? tool['annotations'] : {}
        tools.push({
          name: typeof tool['name'] === 'string' ? tool['name'] : key,
          readOnly: annotations['readOnlyHint'] === true,
          destructive: annotations['destructiveHint'] === true
        })
      }
    }
    const runtime = server['runtimeStatus']
    out.push({
      name: server['name'],
      // A catalogue came back, and the thread's connection (when it has one) is up.
      connected:
        (server['toolsError'] === null || server['toolsError'] === undefined) &&
        (runtime === null || runtime === undefined || runtime === 'connected'),
      tools
    })
  }
  return out
}

/** The next page cursor of a `mcpServerStatus/list` answer, if there is one. */
export function codexMcpNextCursor(response: unknown): string | undefined {
  const next = isRecord(response) ? response['nextCursor'] : undefined
  return typeof next === 'string' && next !== '' ? next : undefined
}
