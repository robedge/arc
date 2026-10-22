// A fake user MCP server (stdio) for the Cursor tool-annotation tests. Never touches the network.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'fake-mcp-user', version: '1.0.0' })
server.registerTool(
  'lookup',
  { description: 'reads', annotations: { readOnlyHint: true } },
  () => ({
    content: [{ type: 'text', text: 'ok' }]
  })
)
server.registerTool(
  'remove',
  { description: 'changes', annotations: { readOnlyHint: false, destructiveHint: true } },
  () => ({ content: [{ type: 'text', text: 'ok' }] })
)
server.registerTool(
  'both',
  { description: 'says both', annotations: { readOnlyHint: true, destructiveHint: true } },
  () => ({ content: [{ type: 'text', text: 'ok' }] })
)
server.registerTool('plain', { description: 'no annotations' }, () => ({
  content: [{ type: 'text', text: 'ok' }]
}))
await server.connect(new StdioServerTransport())
