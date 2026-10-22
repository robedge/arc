import { describe, expect, it } from 'vitest'
import {
  normalizeCodexApproval,
  unwrapShell
} from '../../../../src/main/agents/codex/codex-normalize'
import type {
  CodexApprovalKind,
  CodexApprovalRequest,
  CodexItem,
  JsonObject
} from '../../../../src/main/agents/codex/codex-types'

describe('unwrapShell', () => {
  it.each([
    ["/bin/zsh -lc 'cat hello.txt'", 'cat hello.txt'],
    ["/bin/bash -c 'git status'", 'git status'],
    ['sh -c "echo hi"', 'echo hi'],
    ["/usr/local/bin/zsh -ic 'ls -la'", 'ls -la'],
    ["/bin/zsh -lc 'echo '\\''quoted'\\'''", "echo 'quoted'"],
    ['/bin/zsh -lc "echo \\"a\\" && ls"', 'echo "a" && ls'],
    ['/bin/zsh -lc git status', 'git status']
  ])('%s -> %s', (wrapped, script) => {
    expect(unwrapShell(wrapped)).toBe(script)
  })

  it('returns a command that is not a shell wrapper unchanged', () => {
    expect(unwrapShell('git status')).toBe('git status')
    expect(unwrapShell('')).toBe('')
  })
})

function request(kind: CodexApprovalKind, raw: JsonObject, item?: CodexItem): CodexApprovalRequest {
  return {
    kind,
    method: 'x',
    requestId: 1,
    agentId: 'a',
    threadId: 't',
    turnId: 'u',
    raw,
    ...(item ? { item } : {})
  }
}

describe('normalizeCodexApproval', () => {
  it('turns a command into the script inside its shell wrapper, with the directory it runs in', () => {
    expect(
      normalizeCodexApproval(
        request('command', { command: "/bin/zsh -lc 'git push origin HEAD'", cwd: '/w' })
      )
    ).toEqual({ kind: 'bash', command: 'git push origin HEAD', cwd: '/w' })
  })

  it('treats a command it cannot read as unreadable, which asks', () => {
    expect(normalizeCodexApproval(request('command', {}))).toEqual({ kind: 'bash', command: null })
  })

  it('takes the files of a file change from the item announced before it', () => {
    const item: CodexItem = {
      type: 'fileChange',
      id: 'f1',
      changes: [{ path: '/w/a.ts' }, { path: '/w/b.ts', kind: { type: 'add' } }]
    }
    expect(normalizeCodexApproval(request('file-change', { grantRoot: null }, item))).toEqual({
      kind: 'edit',
      tool: 'Edit',
      paths: ['/w/a.ts', '/w/b.ts']
    })
  })

  it('fails closed on a file change whose files are unknown', () => {
    expect(
      normalizeCodexApproval(request('file-change', { reason: null, grantRoot: null }))
    ).toEqual({ kind: 'edit', tool: 'Edit', paths: [], unknownPaths: true })
    expect(normalizeCodexApproval(request('file-change', { grantRoot: '/w' }))).toEqual({
      kind: 'edit',
      tool: 'Edit',
      paths: ['/w'],
      unknownPaths: true
    })
    // an item without changes is no better
    expect(
      normalizeCodexApproval(
        request('file-change', {}, { type: 'fileChange', id: 'f', changes: [] })
      )
    ).toMatchObject({ unknownPaths: true })
  })

  it('reads the extra folders and network a permissions request asks for', () => {
    expect(
      normalizeCodexApproval(
        request('permissions', {
          reason: 'build output',
          permissions: {
            fileSystem: { read: null, write: ['/opt/out'] },
            network: { enabled: true }
          }
        })
      )
    ).toEqual({
      kind: 'permission',
      reason: 'build output',
      fileSystem: { write: ['/opt/out'] },
      network: true
    })
    expect(normalizeCodexApproval(request('permissions', {}))).toEqual({
      kind: 'permission',
      reason: ''
    })
  })

  it('reads an MCP tool approval from the tool call announced before it, and asks when it knows nothing', () => {
    const item = (extra: JsonObject): CodexItem => ({
      type: 'mcpToolCall',
      id: 'm',
      server: 'figma',
      tool: 'get_file',
      arguments: { id: 1 },
      ...extra
    })
    expect(
      normalizeCodexApproval(request('mcp-elicitation', {}, item({ readOnlyHint: true })))
    ).toEqual({ kind: 'mcp', server: 'figma', tool: 'get_file', args: { id: 1 }, readOnly: 'yes' })
    expect(
      normalizeCodexApproval(request('mcp-elicitation', {}, item({ readOnlyHint: false })))
    ).toMatchObject({ readOnly: 'no' })
    expect(normalizeCodexApproval(request('mcp-elicitation', {}, item({})))).toMatchObject({
      readOnly: 'unknown'
    })
    // no item: the tool comes from the message, and it is not known to be read-only
    expect(
      normalizeCodexApproval(
        request('mcp-elicitation', {
          serverName: 'arc',
          message: 'Allow the arc MCP server to run tool "echo"?'
        })
      )
    ).toEqual({ kind: 'mcp', server: 'arc', tool: 'echo', readOnly: 'unknown' })
  })
})
