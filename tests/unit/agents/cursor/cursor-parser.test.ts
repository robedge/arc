import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import {
  createCursorParser,
  isCursorLimitError,
  type CursorParser
} from '../../../../src/main/agents/cursor/cursor-parser'
import { turnMessages } from './fixtures'

type Of<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

function ofType<T extends AgentEvent['type']>(events: AgentEvent[], type: T): Of<T>[] {
  return events.filter((e): e is Of<T> => e.type === type)
}

let clock = 1000
function newParser(): CursorParser {
  clock = 1000
  return createCursorParser({ agentId: 'w1', now: () => (clock += 10) })
}

/** Plays the turn of a recording into a parser the way the adapter does. */
function replay(
  file: string,
  parser = newParser()
): { events: AgentEvent[]; parser: CursorParser } {
  const events: AgentEvent[] = [...parser.beginTurn()]
  for (const msg of turnMessages(file)) {
    if (msg['method'] === 'session/update') {
      events.push(...parser.parse('session/update', msg['params'] as Record<string, unknown>))
    } else if (
      msg['result'] &&
      typeof msg['result'] === 'object' &&
      'stopReason' in msg['result']
    ) {
      events.push(
        ...parser.endTurn({
          stopReason: String(msg['result']['stopReason']),
          ...('usage' in msg['result'] ? { usage: msg['result']['usage'] } : {})
        })
      )
    }
  }
  return { events, parser }
}

describe('cursor parser on the M1 agent turn', () => {
  const { events, parser } = replay('m1-agent-turn.jsonl')

  it('streams the chunks as text deltas and thinking deltas', () => {
    const text = ofType(events, 'text-delta')
    expect(text.length).toBe(35)
    expect(text[0]).toMatchObject({ agentId: 'w1', text: 'Starting' })
    expect(ofType(events, 'thinking-delta').length).toBe(71)
  })

  it('assembles the assistant messages itself: a new message starts after any tool call', () => {
    const messages = ofType(events, 'assistant-message')
    expect(messages.length).toBeGreaterThan(1)
    expect(new Set(messages.map((m) => m.messageId)).size).toBe(messages.length)
    // Every text delta belongs to the message that is later assembled from them.
    for (const message of messages) {
      const joined = ofType(events, 'text-delta')
        .filter((d) => d.messageId === message.messageId)
        .map((d) => d.text)
        .join('')
      expect(message.text).toBe(joined)
    }
    // The message in front of a tool call is emitted before that tool call.
    const firstTool = events.findIndex((e) => e.type === 'tool-use')
    const firstMessage = events.findIndex((e) => e.type === 'assistant-message')
    expect(firstMessage).toBeLessThan(firstTool)
    expect(messages.at(-1)?.text).toContain('slow')
  })

  it('shows each tool call once, named like the other providers name theirs', () => {
    const uses = ofType(events, 'tool-use')
    expect(uses.map((u) => u.name)).toEqual([
      'Read',
      'Edit',
      'Bash',
      'Bash',
      'Bash',
      'Read',
      'mcp__arc__echo',
      'mcp__arc__slow'
    ])
    expect(uses.map((u) => u.toolUseId)).toEqual([
      'toolcall-2',
      'toolcall-3',
      'toolcall-4',
      'toolcall-5',
      'toolcall-6',
      'toolcall-7',
      'toolcall-8',
      'toolcall-9'
    ])
    expect(uses[0]).toMatchObject({
      summary: 'Read: /tmp/arc-record/repo/README.md',
      readPath: '/tmp/arc-record/repo/README.md'
    })
    // The edit is announced only once its update names the path; the first call says "Edit File".
    expect(uses[1]).toMatchObject({ summary: 'Edit: /tmp/arc-record/repo/notes.txt' })
    expect(uses[1]?.readPath).toBeUndefined()
    expect(uses[2]).toMatchObject({ summary: 'Bash: git status' })
    // An MCP call is named after the server and tool of the update that identifies it, with its first argument.
    expect(uses[6]).toMatchObject({ summary: 'mcp__arc__echo: hi' })
  })

  it('reports each completed call once, with its output and whether it failed', () => {
    const results = ofType(events, 'tool-result')
    expect(results.length).toBe(8)
    const byId = new Map(results.map((r) => [r.toolUseId, r]))
    expect(byId.get('toolcall-2')).toMatchObject({
      isError: false,
      content: '# Scratch\n\nA tiny repo for a recording.\n'
    })
    expect(byId.get('toolcall-3')?.content).toBe('edit /tmp/arc-record/repo/notes.txt')
    expect(byId.get('toolcall-4')?.content).toContain('On branch main')
    // The refused push completed with no output at all.
    expect(byId.get('toolcall-6')).toMatchObject({ isError: false })
    expect(byId.get('toolcall-6')?.content).toBeUndefined()
    expect(byId.get('toolcall-8')).toMatchObject({ isError: false, content: '{"success":true}' })
    // The 60 s MCP timeout is an error result.
    expect(byId.get('toolcall-9')).toMatchObject({
      isError: true,
      content: 'MCP error -32001: Request timed out'
    })
  })

  it('carries what the blocked-call check needs: a command that completed with no rawOutput', () => {
    const push = parser.toolCall('toolcall-6')
    expect(push).toMatchObject({
      kind: 'execute',
      status: 'completed',
      rawInput: { command: 'git push origin HEAD' },
      permissionAsked: false
    })
    expect(push?.rawOutput).toBeUndefined()
    expect((push?.completedAt ?? 0) - (push?.startedAt ?? 0)).toBeGreaterThanOrEqual(0)
    expect(parser.toolCall('toolcall-4')?.rawOutput).toMatchObject({ exitCode: 0 })
    expect(parser.toolCall('toolcall-8')?.rawInput).toMatchObject({
      providerIdentifier: 'arc',
      toolName: 'echo'
    })
    parser.markAsked('toolcall-4')
    expect(parser.toolCall('toolcall-4')?.permissionAsked).toBe(true)
    expect(parser.toolCall('nope')).toBeUndefined()
  })

  it('ends the turn with one completed turn result and reports no usage', () => {
    expect(ofType(events, 'turn-started')).toHaveLength(1)
    const results = ofType(events, 'turn-result')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ ok: true, interrupted: false, status: 'completed' })
    expect(results[0]?.turnId).toBe(ofType(events, 'turn-started')[0]?.turnId)
    expect(events.at(-1)?.type).toBe('turn-result')
    expect(ofType(events, 'usage')).toHaveLength(0)
    expect(ofType(events, 'usage-progress')).toHaveLength(0)
    expect(ofType(events, 'error')).toHaveLength(0)
  })

  it('keeps the last available commands for the command probe and emits nothing for them', () => {
    const p = newParser()
    expect(p.availableCommands()).toEqual([])
    const out = p.parse('session/update', {
      sessionId: 's',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'simplify', description: 'Find low-info comments' },
          { name: 'x' }
        ]
      }
    })
    expect(out).toEqual([])
    expect(p.availableCommands()).toEqual([
      { name: 'simplify', description: 'Find low-info comments' },
      { name: 'x', description: '' }
    ])
  })

  it('ignores the title update and reports an update it does not know as unknown', () => {
    const p = newParser()
    expect(
      p.parse('session/update', {
        update: { sessionUpdate: 'session_info_update', title: 'Test Harness Steps' }
      })
    ).toEqual([])
    expect(p.parse('session/update', { update: { sessionUpdate: 'brand_new' } })).toMatchObject([
      { type: 'unknown' }
    ])
    expect(p.parse('session/surprise', {})).toMatchObject([{ type: 'unknown' }])
    expect(p.parse('session/update', { nonsense: true })).toMatchObject([{ type: 'unknown' }])
  })
})

describe('cursor parser on the plan-blocked turn', () => {
  it('turns "Upgrade your plan to continue" with end_turn into a plan-refused error and a failed turn', () => {
    const { events } = replay('m1-plan-blocked-turn.jsonl')
    const errors = ofType(events, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      kind: 'plan-refused',
      message: 'Upgrade your plan to continue'
    })
    // The refusal is not an answer the brain or the terminal should show.
    expect(ofType(events, 'assistant-message')).toHaveLength(0)
    expect(ofType(events, 'turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
  })

  it('does not take a long answer, or one after a tool call, for a plan block', () => {
    const long = newParser()
    long.beginTurn()
    long.parse('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `The quota logic is in billing.ts. ${'x'.repeat(400)}` }
      }
    })
    expect(ofType(long.endTurn({ stopReason: 'end_turn' }), 'error')).toHaveLength(0)

    const withTool = newParser()
    withTool.beginTurn()
    withTool.parse('session/update', {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'Read x',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/x' }
      }
    })
    withTool.parse('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Upgrade your plan to continue' }
      }
    })
    const out = withTool.endTurn({ stopReason: 'end_turn' })
    expect(ofType(out, 'error')).toHaveLength(0)
    expect(ofType(out, 'assistant-message')).toHaveLength(1)
    expect(ofType(out, 'turn-result')[0]?.ok).toBe(true)
  })
})

describe('cursor parser turn endings', () => {
  it('maps cancelled to an interrupted turn and other stop reasons to a failed one', () => {
    const p = newParser()
    p.beginTurn()
    expect(ofType(p.endTurn({ stopReason: 'cancelled' }), 'turn-result')[0]).toMatchObject({
      ok: false,
      interrupted: true,
      status: 'interrupted'
    })
    p.beginTurn()
    const refused = p.endTurn({ stopReason: 'refusal' })
    expect(ofType(refused, 'error')[0]).toMatchObject({ kind: 'api' })
    expect(ofType(refused, 'turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
  })

  it('reports a failed prompt as an error and classifies a limit message', () => {
    const p = newParser()
    p.beginTurn()
    const out = p.endTurn({ error: 'Rate limit exceeded (429)' })
    expect(ofType(out, 'error')[0]).toMatchObject({ kind: 'rate-limit' })
    expect(ofType(out, 'turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
    p.beginTurn()
    expect(ofType(p.endTurn({ error: 'socket hang up' }), 'error')[0]).toMatchObject({
      kind: 'api'
    })
  })

  it('classifies a failed prompt that says to upgrade the plan as plan-refused, other limits as rate-limit', () => {
    const p = newParser()
    p.beginTurn()
    expect(ofType(p.endTurn({ error: 'Upgrade your plan to continue' }), 'error')[0]).toMatchObject(
      { kind: 'plan-refused' }
    )
    p.beginTurn()
    p.parse('session/update', {
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'You have reached your usage limit' }
      }
    })
    expect(ofType(p.endTurn({ stopReason: 'end_turn' }), 'error')[0]).toMatchObject({
      kind: 'rate-limit'
    })
  })

  it('gives every turn and message an id that differs from the earlier ones', () => {
    const p = newParser()
    const first = ofType(p.beginTurn(), 'turn-started')[0]?.turnId
    const second = ofType(p.beginTurn(), 'turn-started')[0]?.turnId
    expect(first).not.toBe(second)
  })
})

describe('isCursorLimitError', () => {
  it.each([
    'Upgrade your plan to continue',
    'You have reached your usage limit',
    'Rate limit exceeded',
    'HTTP 429 Too Many Requests',
    "You're out of credits",
    'monthly quota exhausted'
  ])('matches %s', (text) => expect(isCursorLimitError(text)).toBe(true))

  it.each(['done', 'git push refused by permissions.', 'Request timed out'])(
    'does not match %s',
    (text) => expect(isCursorLimitError(text)).toBe(false)
  )
})

describe('cursor parser usage', () => {
  it('emits none for the real M1 turn: Cursor reports no tokens', () => {
    const { events } = replay('m1-agent-turn.jsonl')
    expect(ofType(events, 'usage')).toEqual([])
    expect(ofType(events, 'usage-progress')).toEqual([])
  })

  it('maps a prompt-response usage (synthetic fixture) to the four buckets, before the turn-result', () => {
    const { events } = replay('synthetic-usage-prompt-turn.jsonl')
    const [usage] = ofType(events, 'usage')
    expect(ofType(events, 'usage')).toHaveLength(1)
    expect(usage).toMatchObject({
      agentId: 'w1',
      scope: 'turn',
      input: 120,
      cacheWrite: 15,
      cacheRead: 40,
      output: 30,
      maxCallInput: 175,
      callCount: 1,
      partial: false
    })
    const result = ofType(events, 'turn-result')[0]
    expect(usage?.turnId).toBe(result?.turnId)
    expect(events.indexOf(usage as AgentEvent)).toBeLessThan(events.indexOf(result as AgentEvent))
  })

  it('turns usage_update running totals into usage-progress, and the last one into the turn usage', () => {
    const { events } = replay('synthetic-usage-update-turn.jsonl')
    const progress = ofType(events, 'usage-progress')
    expect(progress.map((p) => [p.input, p.cacheRead, p.output])).toEqual([
      [60, 20, 10],
      [120, 40, 30]
    ])
    expect(progress[0]?.turnId).toBe(ofType(events, 'turn-started')[0]?.turnId)
    expect(ofType(events, 'usage')).toMatchObject([
      { input: 120, cacheWrite: 15, cacheRead: 40, output: 30, callCount: 1 }
    ])
  })

  it('prefers the response usage over the last update, and starts each turn afresh', () => {
    const parser = newParser()
    parser.beginTurn()
    parser.parse('session/update', {
      update: { sessionUpdate: 'usage_update', usage: { inputTokens: 5, outputTokens: 1 } }
    })
    const first = parser.endTurn({
      stopReason: 'end_turn',
      usage: { inputTokens: 9, outputTokens: 2 }
    })
    expect(ofType(first, 'usage')[0]).toMatchObject({ input: 9, output: 2 })
    parser.beginTurn()
    expect(ofType(parser.endTurn({ stopReason: 'end_turn' }), 'usage')).toEqual([])
  })

  it('reads the ACP field names and _meta, counts thought tokens as output, ignores junk', () => {
    const parser = newParser()
    parser.beginTurn()
    const events = parser.endTurn({
      stopReason: 'end_turn',
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        thoughtTokens: 2,
        cachedReadTokens: 4,
        cachedWriteTokens: 1
      }
    })
    expect(ofType(events, 'usage')[0]).toMatchObject({
      input: 7,
      cacheWrite: 1,
      cacheRead: 4,
      output: 5
    })
    parser.beginTurn()
    const none = parser.endTurn({ stopReason: 'end_turn', usage: { inputTokens: 'many', used: 1 } })
    expect(ofType(none, 'usage')).toEqual([])
    expect(
      parser.parse('session/update', {
        update: { sessionUpdate: 'usage_update', used: 100, size: 200 }
      })
    ).toEqual([])
  })
})
