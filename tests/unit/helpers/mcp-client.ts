import { readFileSync } from 'node:fs'
import { request } from 'node:http'

/** What the CLI reads from `--mcp-config`. */
export interface McpServerConfig {
  url: string
  headers: Record<string, string>
}

export function readMcpConfig(configPath: string): McpServerConfig {
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>
  }
  const server = parsed.mcpServers['arc']
  if (!server) throw new Error('no arc server in the config')
  return server
}

export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** A raw POST that can set any header, `Host` included (fetch refuses to). */
export function rawPost(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  method = 'POST'
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname,
        method,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(payload === undefined ? {} : { 'content-length': Buffer.byteLength(payload) }),
          ...headers
        }
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (d: string) => (text += d))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text })
        )
      }
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** The JSON-RPC message with this id out of a JSON or SSE body. */
export function parseRpc(body: string, id: number): Record<string, unknown> {
  const messages = body.trimStart().startsWith('{')
    ? [JSON.parse(body) as Record<string, unknown>]
    : body
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => JSON.parse(l.slice(5).trim()) as Record<string, unknown>)
  const found = messages.find((m) => m['id'] === id)
  if (!found) throw new Error(`no answer for ${id} in: ${body}`)
  return found
}

let counter = 1000

/** Calls one method on the bridge the way the CLI would (stateless: no initialize needed). */
export async function mcpRequest(
  config: McpServerConfig,
  method: string,
  params: unknown
): Promise<Record<string, unknown>> {
  const id = ++counter
  const res = await rawPost(config.url, config.headers, { jsonrpc: '2.0', id, method, params })
  if (res.status !== 200) throw new Error(`bridge answered ${res.status}: ${res.body}`)
  return parseRpc(res.body, id)
}

export interface ToolCallOutcome {
  isError: boolean
  /** The tool's JSON text, parsed. */
  value: Record<string, unknown>
}

export async function callTool(
  config: McpServerConfig,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallOutcome> {
  const answer = await mcpRequest(config, 'tools/call', { name, arguments: args })
  if (answer['error']) throw new Error(JSON.stringify(answer['error']))
  const result = answer['result'] as { isError?: boolean; content: { text: string }[] }
  return {
    isError: result.isError === true,
    value: JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown>
  }
}

export async function listTools(config: McpServerConfig): Promise<string[]> {
  const answer = await mcpRequest(config, 'tools/list', {})
  const result = answer['result'] as { tools: { name: string }[] }
  return result.tools.map((t) => t.name).sort()
}
