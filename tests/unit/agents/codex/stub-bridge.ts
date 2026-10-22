import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

export interface StubBridge {
  url: string
  token: string
  /** Every tool call the server saw, with the Authorization header of its request. */
  calls: { tool: string; args: Record<string, unknown>; authorization: string | undefined }[]
  close(): Promise<void>
}

/** A stateless streamable-HTTP MCP server with the three worker tools, behind a bearer token (like Arc's bridge). */
export async function startStubBridge(token = 'stub-token'): Promise<StubBridge> {
  const calls: StubBridge['calls'] = []
  const server = http.createServer((req, res) => {
    void (async () => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401)
        res.end()
        return
      }
      const mcp = new McpServer({ name: 'stub-bridge', version: '0.0.1' })
      for (const name of ['report_progress', 'report_done']) {
        mcp.registerTool(
          name,
          {
            description: name,
            inputSchema: { note: z.string().optional(), summary: z.string().optional() }
          },
          (args) => {
            calls.push({ tool: name, args, authorization: req.headers.authorization })
            return { content: [{ type: 'text' as const, text: `ok:${name}` }] }
          }
        )
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport)
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
