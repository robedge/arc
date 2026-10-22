import { describe, expect, it } from 'vitest'
import { createCursorParser } from '../../../../src/main/agents/cursor/cursor-parser'
import {
  classifyUnaskedCall,
  cursorBlockedText,
  type CursorBlockedNote
} from '../../../../src/main/agents/cursor/cursor-unasked'
import type { CursorToolCall } from '../../../../src/main/agents/cursor/cursor-types'
import type { ClassifyContext } from '../../../../src/main/policy/classify'
import { turnMessages } from './fixtures'

const WORKTREE = '/tmp/arc-record/repo'
const ctx: ClassifyContext = {
  worktreeRoots: [WORKTREE],
  readOnlyDirs: ['/tmp/arc-record/knowledge'],
  cwd: WORKTREE,
  home: '/Users/user',
  tempDirs: []
}

/** The tool calls of the M1 turn that finished without a permission request, as the adapter hands them over. */
function unaskedInM1(): CursorToolCall[] {
  const seen: CursorToolCall[] = []
  let clock = 0
  const parser = createCursorParser({
    agentId: 'w1',
    now: () => (clock += 10),
    onUnasked: (call) => seen.push({ ...call })
  })
  parser.beginTurn()
  for (const msg of turnMessages('m1-agent-turn.jsonl')) {
    if (msg['method'] === 'session/update') {
      parser.parse('session/update', msg['params'] as Record<string, unknown>)
    } else if (msg['method'] === 'session/request_permission') {
      const id = (msg['params'] as { toolCall: { toolCallId: string } }).toolCall.toolCallId
      parser.markAsked(id)
    }
  }
  return seen
}

function call(partial: Partial<CursorToolCall>): CursorToolCall {
  return {
    toolCallId: 't1',
    title: '',
    kind: 'execute',
    status: 'completed',
    rawInput: {},
    locations: [],
    content: [],
    permissionAsked: false,
    startedAt: 1000,
    inProgressAt: 1010,
    completedAt: 1072,
    ...partial
  }
}

describe('what the parser hands over from the M1 turn', () => {
  const unasked = unaskedInM1()

  it('reports the calls that never asked: the read, the edit, the blocked push and the read outside', () => {
    expect(unasked.map((c) => c.kind)).toEqual(['read', 'edit', 'execute', 'read'])
  })

  it('classifies the denied push as blocked: it completed in a few ms with no rawOutput', () => {
    const push = unasked.find((c) => c.kind === 'execute')
    expect(push?.rawOutput).toBeUndefined()
    expect(classifyUnaskedCall(push as CursorToolCall, ctx)).toEqual({
      outcome: 'blocked',
      action: 'git push origin HEAD',
      kind: 'execute'
    })
  })

  it('says nothing about the edit inside the working copy, and nothing about reads', () => {
    const edit = unasked.find((c) => c.kind === 'edit') as CursorToolCall
    expect(classifyUnaskedCall(edit, ctx)).toBeUndefined()
    for (const read of unasked.filter((c) => c.kind === 'read')) {
      expect(classifyUnaskedCall(read, ctx)).toBeUndefined()
    }
  })

  it('classifies that same edit as an edit outside the working copy when the worktree is elsewhere', () => {
    const edit = unasked.find((c) => c.kind === 'edit') as CursorToolCall
    const note = classifyUnaskedCall(edit, { ...ctx, worktreeRoots: ['/tmp/elsewhere/wt'] })
    expect(note).toMatchObject({ outcome: 'outside-edit', kind: 'edit' })
    expect(note?.action).toContain('notes.txt')
  })
})

/** Replays a recorded turn; returns the calls that finished without asking, and the ids that asked. */
function replayUnasked(file: string): { unasked: CursorToolCall[]; asked: string[] } {
  const unasked: CursorToolCall[] = []
  const asked: string[] = []
  let clock = 0
  const parser = createCursorParser({
    agentId: 'w1',
    now: () => (clock += 10),
    onUnasked: (call) => unasked.push({ ...call })
  })
  parser.beginTurn()
  for (const msg of turnMessages(file)) {
    if (msg['method'] === 'session/update') {
      parser.parse('session/update', msg['params'] as Record<string, unknown>)
    } else if (msg['method'] === 'session/request_permission') {
      const id = (msg['params'] as { toolCall: { toolCallId: string } }).toolCall.toolCallId
      asked.push(id)
      parser.markAsked(id)
    }
  }
  return { unasked, asked }
}

describe('the M6 recording (agent started with --sandbox enabled, Write deny on known/)', () => {
  const { unasked, asked } = replayUnasked('m6-sandbox-turn.jsonl')
  const ctx6: ClassifyContext = { ...ctx, readOnlyDirs: ['/tmp/arc-record/known'] }

  it('asks only for `ls ..`; all three file writes run or are refused without a request', () => {
    expect(asked).toEqual(['toolcall-5'])
    expect(unasked.map((c) => c.kind)).toEqual(['edit', 'edit', 'edit'])
  })

  it('the write outside the repo went through (the sandbox did not confine it): a diff, so outside-edit', () => {
    const outside = unasked.find((c) => c.locations[0] === '/tmp/arc-record/outside.txt')
    expect(outside?.content).toHaveLength(1)
    expect(classifyUnaskedCall(outside as CursorToolCall, ctx6)).toEqual({
      outcome: 'outside-edit',
      action: '/tmp/arc-record/outside.txt',
      kind: 'edit'
    })
  })

  it('the Write-denied edit completed with no diff and no rawOutput, so blocked', () => {
    const denied = unasked.find((c) => c.locations[0] === '/tmp/arc-record/known/denied.txt')
    expect(denied?.status).toBe('completed')
    expect(denied?.content).toEqual([])
    expect(denied?.rawOutput).toBeUndefined()
    expect(classifyUnaskedCall(denied as CursorToolCall, ctx6)).toEqual({
      outcome: 'blocked',
      action: '/tmp/arc-record/known/denied.txt',
      kind: 'edit'
    })
  })

  it('says nothing about the write inside the repo', () => {
    const inside = unasked.find((c) => c.locations[0] === '/tmp/arc-record/repo/inside.txt')
    expect(classifyUnaskedCall(inside as CursorToolCall, ctx6)).toBeUndefined()
  })
})

describe('classifyUnaskedCall', () => {
  it('ran-unasked: a protected command that produced output with no permission request', () => {
    const note = classifyUnaskedCall(
      call({
        rawInput: { command: 'scp build.tar.gz deploy@example.com:/srv' },
        rawOutput: { exitCode: 0, stdout: '<html>', stderr: '' },
        completedAt: 1800
      }),
      ctx
    )
    expect(note).toEqual({
      outcome: 'ran-unasked',
      action: 'scp build.tar.gz deploy@example.com:/srv',
      kind: 'execute'
    })
  })

  it('treats a push with no rawOutput that took long as having run, not as blocked', () => {
    const note = classifyUnaskedCall(
      call({ rawInput: { command: 'git push origin HEAD' }, completedAt: 1010 + 30_000 }),
      ctx
    )
    expect(note?.outcome).toBe('ran-unasked')
  })

  it('reads the command from the title when rawInput has none', () => {
    const note = classifyUnaskedCall(call({ title: '`gh pr create --fill`' }), ctx)
    expect(note).toMatchObject({ outcome: 'blocked', action: 'gh pr create --fill' })
  })

  it('says nothing for an ordinary command in the working copy, or for a call that asked', () => {
    expect(
      classifyUnaskedCall(
        call({ rawInput: { command: 'ls' }, rawOutput: { exitCode: 0, stdout: 'a', stderr: '' } }),
        ctx
      )
    ).toBeUndefined()
    expect(
      classifyUnaskedCall(
        call({ rawInput: { command: 'git push origin HEAD' }, permissionAsked: true }),
        ctx
      )
    ).toBeUndefined()
  })

  it('says nothing for a call that has not finished or whose command cannot be read', () => {
    expect(
      classifyUnaskedCall(call({ status: 'in_progress', rawInput: { command: 'git push' } }), ctx)
    ).toBeUndefined()
    expect(classifyUnaskedCall(call({}), ctx)).toBeUndefined()
  })

  it('outside-edit: an edit that went through outside the working copy', () => {
    const note = classifyUnaskedCall(
      call({
        kind: 'edit',
        rawInput: { path: '/Users/user/other/file.ts' },
        locations: ['/Users/user/other/file.ts'],
        content: [{ type: 'diff', path: '/Users/user/other/file.ts', oldText: '', newText: 'x' }]
      }),
      ctx
    )
    expect(note).toEqual({
      outcome: 'outside-edit',
      action: '/Users/user/other/file.ts',
      kind: 'edit'
    })
  })

  it('blocked: an edit under a Write deny leaves no diff and no output', () => {
    const note = classifyUnaskedCall(
      call({ kind: 'edit', locations: ['/tmp/arc-record/knowledge/notes.md'] }),
      ctx
    )
    expect(note).toMatchObject({ outcome: 'blocked', kind: 'edit' })
  })

  it('says nothing for an edit inside the working copy', () => {
    expect(
      classifyUnaskedCall(
        call({
          kind: 'edit',
          locations: [`${WORKTREE}/src/a.ts`],
          content: [{ type: 'diff', path: `${WORKTREE}/src/a.ts` }]
        }),
        ctx
      )
    ).toBeUndefined()
  })
})

describe('cursorBlockedText', () => {
  const who = 'W3 (Cursor)'
  const text = (note: CursorBlockedNote): string => cursorBlockedText(who, note)

  it('names the worker and the action for each outcome', () => {
    expect(text({ outcome: 'blocked', action: 'git push', kind: 'execute' })).toBe(
      "W3 (Cursor) was blocked from running `git push`: Cursor can't ask, so Arc blocked it. Rerun this step on a Claude or Codex worker."
    )
    expect(text({ outcome: 'ran-unasked', action: 'scp x', kind: 'execute' })).toContain(
      'ran `scp x` without asking'
    )
    expect(text({ outcome: 'outside-edit', action: '/a/b.ts', kind: 'edit' })).toBe(
      'W3 (Cursor) changed /a/b.ts outside its working copy.'
    )
    expect(text({ outcome: 'blocked', action: '/a/b.ts', kind: 'edit' })).toContain(
      'blocked from changing /a/b.ts'
    )
  })
})
