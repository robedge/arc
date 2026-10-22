import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpToolInfo } from '../agent-adapter'
import type { CursorMcpSpec } from './cursor-mcp-config'

/**
 * Arc's own `tools/list` against a user's Cursor server (tech spec 2.5, source 3): the permission
 * request carries no annotations and `agent mcp list-tools` prints names only (spike N8), so the
 * server is asked directly, exactly as Cursor would start it. The connection lasts for one call.
 */

/** Lists the tools of the server a `mcp.json` entry defines; rejects when it cannot connect or list. */
export async function listCursorServerTools(
  spec: CursorMcpSpec,
  cwd: string | undefined,
  signal?: AbortSignal
): Promise<McpToolInfo[]> {
  const client = new Client({ name: 'arc-tool-lister', version: '1.0.0' })
  const transport =
    spec.type === 'stdio'
      ? new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...getDefaultEnvironment(), ...spec.env },
          ...(cwd === undefined ? {} : { cwd }),
          stderr: 'ignore'
        })
      : new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers: spec.headers }
        })
  try {
    await client.connect(transport, signal ? { signal } : undefined)
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(
        cursor === undefined ? {} : { cursor },
        signal ? { signal } : undefined
      )
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          readOnly: tool.annotations?.readOnlyHint === true,
          destructive: tool.annotations?.destructiveHint === true
        })
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
    return tools
  } finally {
    await client.close().catch(() => undefined)
  }
}
