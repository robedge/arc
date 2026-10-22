import { describe, expect, it } from 'vitest'
import { normalizeCursorApproval } from '../../../../src/main/agents/cursor/cursor-normalize'
import type { CursorApprovalRequest } from '../../../../src/main/agents/cursor/cursor-types'
import { approvalRequests } from './fixtures'

const requests = approvalRequests('m1-agent-turn.jsonl')
const byTool = (id: string): CursorApprovalRequest => {
  const found = requests.find((r) => r.toolCallId === id)
  if (!found) throw new Error(`no request for ${id}`)
  return found
}

function synthetic(over: Partial<CursorApprovalRequest>): CursorApprovalRequest {
  return {
    agentId: 'w1',
    sessionId: 's',
    requestId: 9,
    toolCallId: 'x',
    title: '',
    kind: 'other',
    options: [],
    raw: {},
    ...over
  }
}

function tool(over: Record<string, unknown>): CursorApprovalRequest['tool'] {
  return {
    toolCallId: 'x',
    title: '',
    kind: 'edit',
    status: 'pending',
    rawInput: {},
    locations: [],
    content: [],
    permissionAsked: true,
    startedAt: 0,
    ...over
  }
}

describe('normalizeCursorApproval on the M1 fixture', () => {
  it('maps the git status and ls commands to bash, with the command from the tool_call', () => {
    expect(normalizeCursorApproval(byTool('toolcall-4'))).toEqual({
      kind: 'bash',
      command: 'git status'
    })
    expect(normalizeCursorApproval(byTool('toolcall-5'))).toEqual({ kind: 'bash', command: 'ls' })
  })

  it('maps the arc echo and slow calls to mcp on the arc server, unknown read-only', () => {
    expect(normalizeCursorApproval(byTool('toolcall-8'))).toEqual({
      kind: 'mcp',
      server: 'arc',
      tool: 'echo',
      args: { text: 'hi' },
      readOnly: 'unknown'
    })
    expect(normalizeCursorApproval(byTool('toolcall-9'))).toMatchObject({
      kind: 'mcp',
      server: 'arc',
      tool: 'slow'
    })
  })
})

describe('normalizeCursorApproval by kind', () => {
  it('takes the command from the backticked title when no tool_call is attached', () => {
    expect(
      normalizeCursorApproval(synthetic({ kind: 'execute', title: '`git push origin HEAD`' }))
    ).toEqual({ kind: 'bash', command: 'git push origin HEAD' })
  })

  it('has a null command when none can be read, and keeps a cwd from the tool_call', () => {
    expect(normalizeCursorApproval(synthetic({ kind: 'execute', title: 'Run' }))).toEqual({
      kind: 'bash',
      command: null
    })
    expect(
      normalizeCursorApproval(
        synthetic({ kind: 'execute', tool: tool({ rawInput: { command: 'ls', cwd: '/w' } }) })
      )
    ).toEqual({ kind: 'bash', command: 'ls', cwd: '/w' })
  })

  it('maps edit, delete and move to an edit of the paths in the tool_call', () => {
    for (const kind of ['edit', 'delete', 'move']) {
      expect(
        normalizeCursorApproval(
          synthetic({
            kind,
            tool: tool({ rawInput: { path: '/w/a.txt' }, locations: ['/w/b.txt'] })
          })
        )
      ).toEqual({ kind: 'edit', tool: 'Edit', paths: ['/w/a.txt', '/w/b.txt'] })
    }
  })

  it('fails closed on an edit with no paths', () => {
    expect(normalizeCursorApproval(synthetic({ kind: 'edit', tool: tool({}) }))).toEqual({
      kind: 'edit',
      tool: 'Edit',
      paths: [],
      unknownPaths: true
    })
  })

  it('maps read, search and think to other, and fetch to WebFetch', () => {
    for (const kind of ['read', 'search', 'think']) {
      expect(normalizeCursorApproval(synthetic({ kind }))).toMatchObject({
        kind: 'other',
        tool: kind
      })
    }
    expect(normalizeCursorApproval(synthetic({ kind: 'fetch' }))).toMatchObject({
      kind: 'other',
      tool: 'WebFetch'
    })
  })

  it('reads an mcp call from the "server: tool" titles when rawInput is missing', () => {
    expect(
      normalizeCursorApproval(synthetic({ title: 'arc-echo: echo', tool: tool({ kind: 'other' }) }))
    ).toMatchObject({ kind: 'mcp', server: 'arc', tool: 'echo' })
    expect(
      normalizeCursorApproval(
        synthetic({ title: 'x', tool: tool({ kind: 'other', title: 'github: create_issue' }) })
      )
    ).toMatchObject({ kind: 'mcp', server: 'github', tool: 'create_issue' })
  })

  it('treats an unidentifiable call as an unknown mcp tool, which asks', () => {
    expect(
      normalizeCursorApproval(synthetic({ title: 'MCP: tool', tool: tool({ title: 'MCP: tool' }) }))
    ).toEqual({ kind: 'mcp', server: 'unknown', tool: 'unknown', readOnly: 'unknown' })
  })
})
