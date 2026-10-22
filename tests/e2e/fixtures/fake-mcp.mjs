#!/usr/bin/env node
/**
 * A stdio MCP server for tests of the personal-MCP approvals (spec 007 section 2.6). Two tools: a
 * read-only one (`readOnlyHint: true`) and one that writes, with no annotations at all, so Arc has to
 * treat it as "ask". It makes no network calls and keeps no state; a call just echoes its arguments.
 * Set `FAKE_MCP_TOOLS` to a JSON object of extra `{ name: annotations }` entries to add more tools.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'fake-mcp', version: '0.0.1' })

function register(name, description, annotations) {
  const config = { description, inputSchema: { id: z.string().optional() } }
  if (annotations !== undefined) config.annotations = annotations
  server.registerTool(name, config, async ({ id }) => ({
    content: [{ type: 'text', text: `${name}:${id ?? ''}` }]
  }))
}

register('figma_read', 'Reads a Figma file. Changes nothing.', { readOnlyHint: true })
register('figma_write', 'Changes a Figma file.', undefined)

function extraTools() {
  try {
    return JSON.parse(process.env.FAKE_MCP_TOOLS ?? '{}')
  } catch {
    return {}
  }
}
for (const [name, annotations] of Object.entries(extraTools()))
  register(name, `Extra tool ${name}.`, annotations)

await server.connect(new StdioServerTransport())
