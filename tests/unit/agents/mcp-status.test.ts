import { describe, expect, it } from 'vitest'
import {
  codexMcpNextCursor,
  parseClaudeMcpStatus,
  parseCodexMcpStatus
} from '../../../src/main/agents/mcp-status'

describe('Claude mcp_status', () => {
  it('reads readOnly and destructive per tool, and a missing hint is not true', () => {
    // The shape the CLI answered with in the S8 spike: a hint appears only when it is true.
    const servers = parseClaudeMcpStatus({
      mcpServers: [
        {
          name: 'fig_ma',
          status: 'connected',
          serverInfo: { name: 'fake-mcp' },
          config: { type: 'stdio', command: 'node' },
          tools: [
            { name: 'figma_read', annotations: { readOnly: true } },
            { name: 'figma_write', annotations: {} },
            { name: 'both', annotations: { readOnly: true, destructive: true } },
            { name: 'bare' }
          ]
        },
        { name: 'needs_login', status: 'needs-auth' }
      ]
    })
    expect(servers).toEqual([
      {
        name: 'fig_ma',
        connected: true,
        tools: [
          { name: 'figma_read', readOnly: true, destructive: false },
          { name: 'figma_write', readOnly: false, destructive: false },
          { name: 'both', readOnly: true, destructive: true },
          { name: 'bare', readOnly: false, destructive: false }
        ]
      },
      { name: 'needs_login', connected: false, tools: [] }
    ])
  })

  it('keeps nothing of the server entries (urls, headers, env)', () => {
    const text = JSON.stringify(
      parseClaudeMcpStatus({
        mcpServers: [
          {
            name: 's',
            status: 'connected',
            config: { url: 'https://x', headers: { Authorization: 'tok-1' } },
            tools: []
          }
        ]
      })
    )
    expect(text).not.toContain('tok-1')
    expect(text).not.toContain('https://x')
  })

  it('gives nothing for an answer it does not understand', () => {
    expect(parseClaudeMcpStatus(undefined)).toEqual([])
    expect(parseClaudeMcpStatus({ mcpServers: 'no' })).toEqual([])
    expect(parseClaudeMcpStatus({ mcpServers: [null, { status: 'connected' }] })).toEqual([])
  })
})

describe('Codex mcpServerStatus/list', () => {
  it('reads readOnlyHint and destructiveHint from the annotations, keyed by tool name', () => {
    const page = {
      data: [
        {
          name: 'fig_ma',
          pluginId: null,
          runtimeStatus: 'connected',
          toolsError: null,
          tools: {
            figma_read: { name: 'figma_read', annotations: { readOnlyHint: true } },
            figma_write: { name: 'figma_write' },
            both: { name: 'both', annotations: { readOnlyHint: true, destructiveHint: true } }
          }
        },
        { name: 'broken', runtimeStatus: 'failed', toolsError: 'boom', tools: {} }
      ],
      nextCursor: null
    }
    expect(parseCodexMcpStatus(page)).toEqual([
      {
        name: 'fig_ma',
        connected: true,
        tools: [
          { name: 'figma_read', readOnly: true, destructive: false },
          { name: 'figma_write', readOnly: false, destructive: false },
          { name: 'both', readOnly: true, destructive: true }
        ]
      },
      { name: 'broken', connected: false, tools: [] }
    ])
    expect(codexMcpNextCursor(page)).toBeUndefined()
    expect(codexMcpNextCursor({ data: [], nextCursor: 'c2' })).toBe('c2')
  })
})
