import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { createClaudeParser, summarizeToolUse } from '../../../src/main/agents/claude-parser'

const dir = resolve('tests/fixtures/claude/2.1.302')

function parseFixture(name: string): AgentEvent[] {
  const parser = createClaudeParser({ agentId: 'brain', now: () => 1 })
  return readFileSync(resolve(dir, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => parser.parse(line))
}

/** Collapses runs of the same type: ['session', 'text-delta', ...]. */
function shape(events: AgentEvent[]): string[] {
  const out: string[] = []
  for (const e of events) if (out[out.length - 1] !== e.type) out.push(e.type)
  return out
}

function ofType<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
}

describe('claude-parser fixtures', () => {
  it('text-turn: session, text deltas, usage progress, assistant message, rate limit, ok result', () => {
    const events = parseFixture('text-turn.jsonl')
    expect(shape(events)).toEqual([
      'session',
      'text-delta',
      'usage-progress',
      'assistant-message',
      'rate-limit',
      'usage',
      'turn-result'
    ])
    const [session] = ofType(events, 'session')
    expect(session).toMatchObject({
      providerSessionId: 'ce6ec5ca-6d3f-4ea4-882e-d24b2331f626',
      model: 'claude-haiku-5-5',
      permissionMode: 'default',
      agentId: 'brain',
      ts: 1
    })
    expect(session?.mcpServers.length).toBeGreaterThan(0)
    expect(session?.mcpServers[0]).toEqual({ name: 'claude.ai Claude Docs', status: 'pending' })
    const delta = ofType(events, 'text-delta')[0]
    expect(delta).toMatchObject({ messageId: 'msg_011Cg8HTV8t1BzjCE8xDtf38', text: 'pong' })
    expect(ofType(events, 'assistant-message')[0]).toMatchObject({
      messageId: 'msg_011Cg8HTV8t1BzjCE8xDtf38',
      text: 'pong'
    })
    expect(ofType(events, 'rate-limit')[0]).toMatchObject({
      resetsAt: 1792275600,
      status: 'allowed'
    })
    expect(ofType(events, 'turn-result')[0]).toEqual({
      type: 'turn-result',
      agentId: 'brain',
      ts: 1,
      ok: true,
      interrupted: false,
      durationMs: 1424,
      status: 'completed'
    })
    expect(session).toMatchObject({ provider: 'claude' })
    expect(ofType(events, 'rate-limit')[0]).toMatchObject({ provider: 'claude' })
  })

  it('interrupt: control-ack and an interrupted turn-result, then a normal second turn', () => {
    const events = parseFixture('interrupt.jsonl')
    const acks = ofType(events, 'control-ack')
    expect(acks).toEqual([
      { type: 'control-ack', agentId: 'brain', ts: 1, requestId: 'req_int_1', ok: true }
    ])
    const results = ofType(events, 'turn-result')
    expect(results.map((r) => [r.ok, r.interrupted])).toEqual([
      [false, true],
      [true, false]
    ])
    // The partial text stays, and the interrupt result is not an error event.
    expect(ofType(events, 'text-delta').length).toBeGreaterThan(5)
    expect(ofType(events, 'error')).toEqual([])
    // The replayed user messages and the "[Request interrupted by user]" event are not chat text.
    expect(events.some((e) => JSON.stringify(e).includes('Request interrupted'))).toBe(false)
    expect(ofType(events, 'session')).toHaveLength(2)
  })

  it('treats error_during_execution after a control ack as interrupted even without terminal_reason', () => {
    const parser = createClaudeParser({ agentId: 'a', now: () => 1 })
    parser.parse(
      '{"type":"control_response","response":{"subtype":"success","request_id":"r","response":{}}}'
    )
    const events = parser.parse(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":5}'
    )
    expect(ofType(events, 'turn-result')[0]).toMatchObject({
      ok: false,
      interrupted: true,
      status: 'interrupted'
    })
    expect(ofType(events, 'error')).toEqual([])
    // Without the ack it is a real failure.
    const failed = parser.parse(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"duration_ms":5}'
    )
    expect(ofType(failed, 'turn-result')[0]).toMatchObject({
      ok: false,
      interrupted: false,
      status: 'failed'
    })
    expect(ofType(failed, 'error')[0]).toMatchObject({ kind: 'api' })
  })

  it('interrupt: thinking deltas with no visible text are dropped', () => {
    expect(ofType(parseFixture('interrupt.jsonl'), 'thinking-delta')).toEqual([])
  })

  it('auth-failure: an auth error event and a failed turn', () => {
    const events = parseFixture('auth-failure.jsonl')
    const errors = ofType(events, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'auth', message: 'Not logged in · Please run /login' })
    expect(ofType(events, 'turn-result')[0]).toMatchObject({ ok: false, interrupted: false })
  })

  it('permission-prompt: Bash tool use with a summary, then a successful tool result', () => {
    const events = parseFixture('permission-prompt.jsonl')
    const use = ofType(events, 'tool-use')
    expect(use).toHaveLength(1)
    expect(use[0]).toMatchObject({ name: 'Bash', summary: 'Bash: echo hi > out.txt' })
    const res = ofType(events, 'tool-result')
    expect(res).toEqual([
      {
        type: 'tool-result',
        agentId: 'brain',
        ts: 1,
        toolUseId: use[0]?.toolUseId,
        isError: false,
        // The result text is carried for the terminal transcript.
        content: res[0]?.content
      }
    ])
    expect(typeof res[0]?.content).toBe('string')
    // Tool input JSON deltas are not chat text.
    expect(ofType(events, 'text-delta').every((d) => !d.text.includes('{'))).toBe(true)
  })

  it('tool-turn: the tool result carries its text', () => {
    const results = ofType(parseFixture('tool-turn.jsonl'), 'tool-result')
    expect(results.map((r) => r.content)).toContain('pong-ro')
  })

  it('permission-deny: the tool result is an error', () => {
    const events = parseFixture('permission-deny.jsonl')
    const use = ofType(events, 'tool-use')[0]
    const res = ofType(events, 'tool-result')
    expect(res).toHaveLength(1)
    expect(res[0]).toMatchObject({ toolUseId: use?.toolUseId, isError: true })
    expect(ofType(events, 'turn-result')[0]).toMatchObject({ ok: true })
  })

  it('tool-turn: ToolSearch noise is dropped, the MCP call and its result remain', () => {
    const events = parseFixture('tool-turn.jsonl')
    expect(ofType(events, 'tool-use').map((e) => e.name)).toEqual(['mcp__arc__ping_ro'])
    expect(ofType(events, 'tool-use')[0]?.summary).toBe('mcp__arc__ping_ro')
    expect(ofType(events, 'tool-result')).toHaveLength(1)
    expect(ofType(events, 'assistant-message').at(-1)?.text).toContain('pong-ro')
  })

  it('plan-blocked: the blocked call yields an error tool-result', () => {
    const events = parseFixture('plan-blocked.jsonl')
    expect(ofType(events, 'tool-result').some((r) => r.isError)).toBe(true)
  })

  it('mcp-timeout: timed-out tool surfaces as an error result and the turn still ends', () => {
    const events = parseFixture('mcp-timeout.jsonl')
    expect(ofType(events, 'tool-result').some((r) => r.isError)).toBe(true)
    expect(ofType(events, 'turn-result')).toHaveLength(1)
  })

  it('every fixture parses without unknown events and never throws', () => {
    for (const name of [
      'text-turn',
      'tool-turn',
      'plan-blocked',
      'permission-prompt',
      'permission-deny',
      'interrupt',
      'mcp-timeout',
      'auth-failure'
    ]) {
      expect(ofType(parseFixture(`${name}.jsonl`), 'unknown'), name).toEqual([])
    }
  })

  it('hook and status noise never becomes chat text', () => {
    const parser = createClaudeParser({ agentId: 'a' })
    for (const line of [
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}',
      '{"type":"system","subtype":"hook_response","output":"hello"}',
      '{"type":"system","subtype":"status","status":"requesting"}'
    ]) {
      expect(parser.parse(line)).toEqual([])
    }
  })
})

describe('claude-parser robustness', () => {
  const parser = createClaudeParser({ agentId: 'a', now: () => 7 })

  it('malformed JSON becomes unknown with the raw line', () => {
    expect(parser.parse('{"type": oops')).toEqual([
      { type: 'unknown', agentId: 'a', ts: 7, raw: '{"type": oops' }
    ])
  })

  it('unknown types and non-objects become unknown', () => {
    expect(parser.parse('{"type":"brand_new","x":1}')[0]).toMatchObject({
      type: 'unknown',
      raw: { type: 'brand_new', x: 1 }
    })
    expect(parser.parse('42')[0]).toMatchObject({ type: 'unknown', raw: 42 })
    expect(parser.parse('null')[0]).toMatchObject({ type: 'unknown' })
  })

  it('a known type with the wrong shape becomes unknown instead of throwing', () => {
    expect(parser.parse('{"type":"assistant","message":"nope"}')[0]).toMatchObject({
      type: 'unknown'
    })
    expect(parser.parse('{"type":"system","subtype":"init"}')[0]).toMatchObject({ type: 'unknown' })
  })

  it('blank lines are ignored', () => {
    expect(parser.parse('')).toEqual([])
    expect(parser.parse('   ')).toEqual([])
  })

  it('summarizes tool input', () => {
    expect(summarizeToolUse('Read', { file_path: '/a/b.ts' })).toBe('Read: /a/b.ts')
    expect(summarizeToolUse('Grep', { pattern: 'foo' })).toBe('Grep: foo')
    expect(summarizeToolUse('Bash', { command: 'a\n  b' })).toBe('Bash: a b')
    expect(summarizeToolUse('Weird', 5)).toBe('Weird')
    expect(summarizeToolUse('Bash', { command: 'x'.repeat(500) }).length).toBeLessThanOrEqual(130)
  })
})

describe('claude-parser token usage', () => {
  type Usage = Extract<AgentEvent, { type: 'usage' }>
  const usages = (events: AgentEvent[]): Usage[] => ofType(events, 'usage')
  const turnUsages = (events: AgentEvent[]): Usage[] =>
    usages(events).filter((u) => u.scope === 'turn')

  it('text-turn: totals from the result, one request, firstCall, model and context window', () => {
    const events = parseFixture('text-turn.jsonl')
    expect(usages(events)).toEqual([
      expect.objectContaining({
        scope: 'turn',
        turnId: '1',
        model: 'claude-haiku-5-5',
        input: 2,
        cacheWrite: 3945,
        cacheRead: 14069,
        output: 4,
        maxCallInput: 2 + 3945 + 14069,
        callCount: 1,
        firstCall: { input: 2, cacheWrite: 3945, cacheRead: 14069 },
        contextWindow: 1000000,
        perModel: {
          'claude-haiku-5-5': { input: 2, cacheWrite: 3945, cacheRead: 14069, output: 4 }
        },
        partial: false
      })
    ])
    const types = events.map((e) => e.type)
    expect(types.indexOf('usage')).toBe(types.indexOf('turn-result') - 1)
  })

  it('tool-turn: one id repeated per content block counts once; max and count come from the requests', () => {
    // 4 assistant lines, 3 message ids (the first id carries a thinking and a tool_use block).
    const [usage] = turnUsages(parseFixture('tool-turn.jsonl'))
    expect(usage).toMatchObject({
      input: 6,
      cacheWrite: 5921,
      cacheRead: 50663,
      output: 230,
      callCount: 3,
      maxCallInput: 2 + 69 + 18932,
      firstCall: { input: 2, cacheWrite: 5571, cacheRead: 13080 },
      partial: false
    })
  })

  it.each([
    {
      name: 'the last write of an id wins',
      lines: [
        assistant('m1', {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
          output_tokens: 1
        }),
        assistant('m1', {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 100,
          output_tokens: 9
        }),
        assistant('m2', {
          input_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 300,
          output_tokens: 4
        }),
        result({
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0
        })
      ],
      expected: {
        input: 2,
        cacheRead: 400,
        output: 13,
        callCount: 2,
        maxCallInput: 301,
        partial: true
      }
    }
  ])('interrupt zero-result fallback built from the accumulator: $name', ({ lines, expected }) => {
    const [usage] = turnUsages(feed(lines))
    expect(usage).toMatchObject(expected)
  })

  it('interrupt: a zero result falls back to the assistant messages (partial), the next turn is normal', () => {
    const [first, second] = turnUsages(parseFixture('interrupt.jsonl'))
    expect(first).toMatchObject({
      turnId: '1',
      input: 2,
      cacheWrite: 6574,
      cacheRead: 11454,
      output: 8,
      maxCallInput: 2 + 6574 + 11454,
      callCount: 1,
      model: 'claude-haiku-5-5',
      partial: true,
      firstCall: { input: 2, cacheWrite: 6574, cacheRead: 11454 }
    })
    expect(second).toMatchObject({
      turnId: '2',
      input: 2,
      cacheWrite: 6560,
      cacheRead: 14545,
      output: 53,
      partial: false
    })
    // the accumulator was reset: the first turn's message is not counted again
    expect(second?.callCount).toBe(1)
    expect(second?.firstCall).toBeUndefined()
  })

  it('auth-failure: a synthetic zero-token message and a zero result produce no usage', () => {
    expect(usages(parseFixture('auth-failure.jsonl'))).toEqual([])
  })

  it('subagent-background: helper messages are their own events, outside max, first call and totals', () => {
    const events = parseFixture('subagent-background.jsonl')
    const helpers = usages(events).filter((u) => u.scope === 'helper')
    // two helper message ids; aUjb repeats for its thinking and text blocks
    expect(helpers).toHaveLength(2)
    expect(helpers[0]).toMatchObject({
      input: 2,
      cacheWrite: 3652,
      cacheRead: 8318,
      output: 17,
      maxCallInput: 2 + 3652 + 8318,
      callCount: 1,
      partial: false
    })
    expect(helpers[1]).toMatchObject({ cacheWrite: 684, cacheRead: 11970, output: 4 })
    const [first, second] = turnUsages(events)
    expect(first).toMatchObject({
      input: 4,
      cacheWrite: 4899,
      cacheRead: 38455,
      callCount: 2,
      maxCallInput: 2 + 634 + 21360,
      firstCall: { input: 2, cacheWrite: 4265, cacheRead: 17095 }
    })
    expect(second).toMatchObject({
      input: 4,
      cacheWrite: 627,
      cacheRead: 21994,
      maxCallInput: 4 + 627 + 21994
    })
    expect(second?.firstCall).toBeUndefined()
  })

  it('modelUsage is cumulative over the process: each turn gets the difference', () => {
    const [first, second] = turnUsages(parseFixture('subagent-background.jsonl'))
    expect(first?.perModel).toEqual({
      'claude-haiku-5-5': { input: 4, cacheWrite: 4899, cacheRead: 38455, output: 254 }
    })
    // 12/456/80737/9862 cumulative, minus the first turn; it also holds the helpers' requests
    expect(second?.perModel).toEqual({
      'claude-haiku-5-5': { input: 8, cacheWrite: 4963, cacheRead: 42282, output: 202 }
    })
  })

  it('splits a result that used two models', () => {
    const [usage] = turnUsages(
      feed([
        assistant(
          'm1',
          {
            input_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
            output_tokens: 1
          },
          'claude-opus-5'
        ),
        result(
          {
            input_tokens: 3,
            output_tokens: 5,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 0
          },
          {
            'claude-opus-5': {
              inputTokens: 1,
              outputTokens: 2,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 0,
              contextWindow: 200000
            },
            'claude-haiku-5-5': {
              inputTokens: 2,
              outputTokens: 3,
              cacheReadInputTokens: 20,
              cacheCreationInputTokens: 0,
              contextWindow: 1000000
            }
          }
        )
      ])
    )
    expect(usage?.perModel).toEqual({
      'claude-opus-5': { input: 1, cacheWrite: 0, cacheRead: 10, output: 2 },
      'claude-haiku-5-5': { input: 2, cacheWrite: 0, cacheRead: 20, output: 3 }
    })
    expect(usage).toMatchObject({
      model: 'claude-opus-5',
      contextWindow: 200000,
      input: 3,
      output: 5
    })
  })
})

function assistant(
  id: string,
  usage: object,
  model = 'claude-haiku-5-5',
  parent: string | null = null
): string {
  return JSON.stringify({
    type: 'assistant',
    parent_tool_use_id: parent,
    message: { id, model, usage, content: [{ type: 'text', text: 'x' }] }
  })
}

function result(usage: object, modelUsage?: object): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1,
    usage,
    ...(modelUsage ? { modelUsage } : {})
  })
}

function feed(lines: string[]): AgentEvent[] {
  const parser = createClaudeParser({ agentId: 'brain', now: () => 1 })
  return lines.flatMap((line) => parser.parse(line))
}

describe('claude-parser usage progress', () => {
  type Progress = Extract<AgentEvent, { type: 'usage-progress' }>
  const progresses = (events: AgentEvent[]): Progress[] => ofType(events, 'usage-progress')
  const request = (id: string, cacheRead: number): string =>
    assistant(id, {
      input_tokens: 3,
      cache_creation_input_tokens: 40,
      cache_read_input_tokens: cacheRead,
      output_tokens: 20
    })
  const done = result(
    {
      input_tokens: 6,
      cache_creation_input_tokens: 80,
      cache_read_input_tokens: 1300,
      output_tokens: 40
    },
    {}
  )

  it('sends the running total of the turn after each new request', () => {
    const events = feed([request('m1', 600), request('m2', 700), done])
    expect(progresses(events)).toEqual([
      expect.objectContaining({
        turnId: '1',
        input: 3,
        cacheWrite: 40,
        cacheRead: 600,
        output: 20,
        callCount: 1
      }),
      expect.objectContaining({
        turnId: '1',
        input: 6,
        cacheWrite: 80,
        cacheRead: 1300,
        output: 40,
        callCount: 2
      })
    ])
    // The final usage event follows the progress, so the recorder's turn id lines up.
    const types = events.map((e) => e.type)
    expect(types.indexOf('usage')).toBeGreaterThan(types.lastIndexOf('usage-progress'))
    expect(ofType(events, 'usage')[0]?.turnId).toBe('1')
  })

  it('does not repeat itself for the content blocks of one message id', () => {
    expect(
      progresses(feed([request('m1', 600), request('m1', 600), request('m1', 600)]))
    ).toHaveLength(1)
  })

  it('numbers the next turn after the result, and starts its total again', () => {
    const events = feed([request('m1', 600), done, request('m2', 700)])
    expect(progresses(events).map((p) => [p.turnId, p.callCount, p.cacheRead])).toEqual([
      ['1', 1, 600],
      ['2', 1, 700]
    ])
  })

  it('sends none for a helper request or a zero-token message', () => {
    const zero = assistant('z', { input_tokens: 0, output_tokens: 0 })
    const helper = assistant(
      'h1',
      { input_tokens: 2, output_tokens: 5 },
      'claude-haiku-5-5',
      'toolu_1'
    )
    expect(progresses(feed([zero, helper]))).toEqual([])
  })
})

describe('claude-parser readPath', () => {
  // read-tools.jsonl is hand-written in the recorded shape: one tool call per assistant message.
  const uses = ofType(parseFixture('read-tools.jsonl'), 'tool-use')

  it('Read gives its file_path', () => {
    expect(uses.find((u) => u.toolUseId === 't1')?.readPath).toBe('/repo/src/a.ts')
  })

  it('Grep counts only when its path names a single file', () => {
    expect(uses.find((u) => u.toolUseId === 't2')?.readPath).toBe('/repo/src/a.ts')
    expect(uses.find((u) => u.toolUseId === 't3')?.readPath).toBeUndefined()
  })

  it('Glob never counts: no path, or a pattern as path', () => {
    expect(uses.find((u) => u.toolUseId === 't4')?.readPath).toBeUndefined()
    expect(uses.find((u) => u.toolUseId === 't5')?.readPath).toBeUndefined()
  })

  it('other tools and paths over 500 characters carry none', () => {
    expect(uses.find((u) => u.toolUseId === 't6')?.readPath).toBeUndefined()
    expect(uses.find((u) => u.toolUseId === 't7')?.readPath).toBeUndefined()
    expect(uses).toHaveLength(7)
  })
})
