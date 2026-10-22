import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import { createCodexParser } from '../../../../src/main/agents/codex/codex-parser'
import type { JsonObject } from '../../../../src/main/agents/codex/codex-types'

interface WireLine {
  dir: string
  msg?: { method?: string; id?: unknown; params?: JsonObject }
}

function load(file: string): WireLine[] {
  return readFileSync(resolve('tests/fixtures/codex/0.162.1', file), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as WireLine)
}

/** The server's notifications (a method and no id), in order. */
function notifications(file: string): { method: string; params: JsonObject }[] {
  return load(file)
    .filter((l) => l.dir === 's2c' && l.msg?.method !== undefined && l.msg.id === undefined)
    .map((l) => ({ method: l.msg?.method ?? '', params: l.msg?.params ?? {} }))
}

function parseAll(file: string): AgentEvent[] {
  const parser = createCodexParser({ agentId: 'w1', now: () => 1 })
  return notifications(file).flatMap((n) => parser.parse(n.method, n.params))
}

describe('codex-parser against the real recording', () => {
  const events = parseAll('real-turn.jsonl')
  const of = <T extends AgentEvent['type']>(type: T): Extract<AgentEvent, { type: T }>[] =>
    events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)

  it('maps the commands to Bash with the shell wrapper removed, and their output to results', () => {
    const bash = of('tool-use').filter((e) => e.name === 'Bash')
    expect(bash.map((e) => e.summary)).toEqual([
      'Bash: cat hello.txt',
      'Bash: git commit -am record'
    ])
    const results = of('tool-result')
    const cat = results.find((r) => r.toolUseId === bash[0]?.toolUseId)
    expect(cat).toMatchObject({ isError: false, content: 'hello\n' })
    const commit = results.find((r) => r.toolUseId === bash[1]?.toolUseId)
    // The sandbox prints noise on stderr; the exit code decides, not the text.
    expect(commit?.isError).toBe(false)
    expect(commit?.content).toContain('[record 5f083c5] record')
  })

  it('a command whose commandActions read a file carries readPath; others carry none', () => {
    const [cat, commit] = of('tool-use').filter((e) => e.name === 'Bash')
    expect(cat?.readPath).toBe('<TMP>/wt/hello.txt')
    expect(commit?.readPath).toBeUndefined()
    expect(of('tool-use').find((e) => e.name === 'Edit')?.readPath).toBeUndefined()
  })

  it('maps the patch to Edit with the file, and the MCP call to mcp:<server>.<tool>', () => {
    const edit = of('tool-use').find((e) => e.name === 'Edit')
    expect(edit?.summary).toBe('Edit: 1 file: <TMP>/wt/hello.txt')
    const mcp = of('tool-use').find((e) => e.name === 'mcp:arc.echo')
    expect(mcp?.summary).toBe('mcp:arc.echo: ping')
    const mcpResult = of('tool-result').find((r) => r.toolUseId === mcp?.toolUseId)
    expect(mcpResult).toMatchObject({ isError: false, content: 'echo:ping' })
    // every tool-use has exactly one tool-result
    expect(of('tool-result')).toHaveLength(of('tool-use').length)
  })

  it('maps the final answer to an assistant message, with its delta first', () => {
    expect(of('text-delta').map((e) => e.text)).toEqual(['done'])
    expect(of('assistant-message').map((e) => e.text)).toEqual(['done'])
  })

  it('maps the turn start and end with the turn id and status', () => {
    const started = of('turn-started')
    const result = of('turn-result')
    expect(started).toHaveLength(1)
    expect(result).toEqual([
      expect.objectContaining({
        ok: true,
        interrupted: false,
        status: 'completed',
        durationMs: 14307,
        turnId: started[0]?.turnId
      })
    ])
    expect(events.indexOf(result[0] as AgentEvent)).toBe(events.length - 1)
  })

  it('maps token usage per model call, with cached tokens counted apart', () => {
    const usage = of('usage')
    expect(usage).toHaveLength(6)
    expect(usage[0]).toMatchObject({
      scope: 'turn',
      input: 17125,
      output: 35,
      cacheRead: 0,
      cacheWrite: 0,
      maxCallInput: 17125,
      callCount: 1,
      contextWindow: 258400,
      partial: false
    })
    expect(usage[1]).toMatchObject({ input: 289, cacheRead: 16896, maxCallInput: 17185 })
    expect(usage.every((u) => u.turnId === of('turn-started')[0]?.turnId)).toBe(true)
  })

  it('maps the rate limits and the MCP startup statuses', () => {
    expect(of('rate-limit')[0]).toMatchObject({
      provider: 'codex',
      status: 'allowed',
      resetsAt: 1792887685
    })
    expect(of('mcp-status').map((e) => `${e.name}:${e.status}`)).toEqual([
      'arc:starting',
      'codex_apps:starting',
      'arc:ready',
      'codex_apps:ready'
    ])
  })

  it('turns notifications it does not map into unknown events and never throws', () => {
    const methods = of('unknown').map((e) => (e.raw as { method: string }).method)
    expect(new Set(methods)).toEqual(
      new Set([
        'remoteControl/status/changed',
        'account/updated',
        'thread/settings/updated',
        'turn/moderationMetadata'
      ])
    )
    expect(methods.filter((m) => m === 'turn/moderationMetadata').length).toBeGreaterThan(3)
  })

  it('stays silent for status, diff and output-delta notifications', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    for (const method of [
      'thread/started',
      'thread/status/changed',
      'turn/diff/updated',
      'serverRequest/resolved',
      'item/commandExecution/outputDelta'
    ]) {
      expect(parser.parse(method, {})).toEqual([])
    }
  })
})

describe('codex-parser details', () => {
  it('remembers the items so an approval can find the item that raised it', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    for (const n of notifications('real-turn.jsonl')) parser.parse(n.method, n.params)
    expect(parser.item('exec-6a65c833-0fe6-45a7-a210-21ac8bcf990a')?.type).toBe('fileChange')
    expect(parser.item('exec-2a6e5610-55da-4d4c-8f17-59751fcd00d6')?.type).toBe('commandExecution')
    expect(parser.item('nope')).toBeUndefined()
  })

  it('finds the MCP call an elicitation belongs to (spike S4) and forgets it once it completed', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    const lines = load('mcp-elicitation.jsonl').filter((l) => l.dir === 's2c')
    const started = lines[0]?.msg
    parser.parse(started?.method ?? '', started?.params ?? {})
    expect(parser.activeMcpCall('arc')).toMatchObject({ tool: 'echo', readOnlyHint: true })
    expect(parser.activeMcpCall('other')).toBeUndefined()
    const completed = lines.find((l) => l.msg?.method === 'item/completed')?.msg
    parser.parse(completed?.method ?? '', completed?.params ?? {})
    expect(parser.activeMcpCall('arc')).toBeUndefined()
  })

  it('reports a failed turn once: the error notification, then the failed result', () => {
    const parser = createCodexParser({ agentId: 'w1', now: () => 5 })
    const error = parser.parse('error', {
      threadId: 't',
      turnId: 'u1',
      willRetry: false,
      error: { message: 'Sign in again', codexErrorInfo: 'unauthorized' }
    })
    expect(error).toEqual([
      { type: 'error', agentId: 'w1', ts: 5, kind: 'auth', message: 'Sign in again' }
    ])
    const done = parser.parse('turn/completed', {
      threadId: 't',
      turn: { id: 'u1', status: 'failed', durationMs: 9, error: { message: 'Sign in again' } }
    })
    expect(done.map((e) => e.type)).toEqual(['turn-result'])
    expect(done[0]).toMatchObject({ ok: false, interrupted: false, status: 'failed' })
  })

  it('reports why a turn failed when no error notification came, and skips a retried error', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    expect(
      parser.parse('error', { turnId: 'u', willRetry: true, error: { message: 'reconnecting' } })
    ).toEqual([])
    const done = parser.parse('turn/completed', {
      turn: {
        id: 'u',
        status: 'failed',
        error: { message: 'boom', codexErrorInfo: { httpConnectionFailed: {} } }
      }
    })
    expect(done.map((e) => e.type)).toEqual(['error', 'turn-result'])
    expect(done[0]).toMatchObject({ kind: 'api', message: 'boom' })
  })

  it('maps an interrupted turn, rate-limit errors and a rejected limit', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    const done = parser.parse('turn/completed', { turn: { id: 'u', status: 'interrupted' } })
    expect(done).toEqual([
      expect.objectContaining({
        type: 'turn-result',
        ok: false,
        interrupted: true,
        status: 'interrupted'
      })
    ])
    const limited = parser.parse('error', {
      turnId: 'v',
      willRetry: false,
      error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }
    })
    expect(limited[0]).toMatchObject({ kind: 'rate-limit' })
    const rejected = parser.parse('account/rateLimits/updated', {
      rateLimits: { primary: { usedPercent: 100, resetsAt: 7 }, rateLimitReachedType: 'primary' }
    })
    expect(rejected[0]).toMatchObject({ type: 'rate-limit', status: 'rejected', resetsAt: 7 })
  })

  it('maps plan updates, rerouted models and reasoning summaries', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    expect(
      parser.parse('turn/plan/updated', {
        plan: [
          { step: 'Read', status: 'completed' },
          { step: 'Edit', status: 'pending' }
        ]
      })
    ).toEqual([
      expect.objectContaining({
        type: 'plan-updated',
        items: [
          { text: 'Read', status: 'completed' },
          { text: 'Edit', status: 'pending' }
        ]
      })
    ])
    expect(parser.parse('model/rerouted', { fromModel: 'a', toModel: 'b', reason: 'x' })).toEqual([
      expect.objectContaining({ type: 'model-rerouted', from: 'a', to: 'b' })
    ])
    expect(
      parser.parse('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Thinking' })
    ).toEqual([
      expect.objectContaining({ type: 'thinking-delta', messageId: 'r1', text: 'Thinking' })
    ])
    // once streamed, the completed item adds nothing
    expect(
      parser.parse('item/completed', {
        item: { type: 'reasoning', id: 'r1', summary: ['Thinking'] }
      })
    ).toEqual([])
  })

  it('shows an MCP failure as an error result and any other tool item by its type', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    parser.parse('item/started', {
      item: {
        type: 'mcpToolCall',
        id: 'm',
        server: 'figma',
        tool: 'get',
        status: 'inProgress',
        arguments: {}
      }
    })
    const failed = parser.parse('item/completed', {
      item: {
        type: 'mcpToolCall',
        id: 'm',
        server: 'figma',
        tool: 'get',
        status: 'failed',
        error: { message: 'timed out' }
      }
    })
    expect(failed).toEqual([
      expect.objectContaining({
        type: 'tool-result',
        toolUseId: 'm',
        isError: true,
        content: 'timed out'
      })
    ])
    const search = parser.parse('item/started', {
      item: { type: 'webSearch', id: 'w', query: 'arc' }
    })
    expect(search).toEqual([
      expect.objectContaining({ type: 'tool-use', name: 'webSearch', summary: 'webSearch: arc' })
    ])
  })

  it('does not throw on malformed params', () => {
    const parser = createCodexParser({ agentId: 'w1' })
    for (const method of [
      'item/started',
      'item/completed',
      'turn/completed',
      'thread/tokenUsage/updated',
      'error'
    ]) {
      const events = parser.parse(method, { garbage: true })
      expect(events.map((e) => e.type)).toEqual(['unknown'])
    }
  })
})

describe('codex-parser token usage', () => {
  const counts = (input: number, cached: number, output: number, cacheWrite = 0): JsonObject => ({
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0
  })
  const update = (
    total: JsonObject | undefined,
    last: JsonObject,
    threadId = 't1'
  ): JsonObject => ({
    threadId,
    turnId: 'turn-1',
    tokenUsage: { ...(total ? { total } : {}), last, modelContextWindow: 1000 }
  })
  const usageOf = (events: AgentEvent[]): Extract<AgentEvent, { type: 'usage' }>[] =>
    events.filter((e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage')
  const run = (updates: JsonObject[], debug?: (m: string, d: unknown) => void): AgentEvent[] => {
    const parser = createCodexParser({ agentId: 'w1', now: () => 1, ...(debug ? { debug } : {}) })
    return updates.flatMap((u) => parser.parse('thread/tokenUsage/updated', u))
  }

  it('real-turn: the per-update deltas add up to the final cumulative total', () => {
    const usage = usageOf(parseAll('real-turn.jsonl'))
    const sum = (key: 'input' | 'cacheRead' | 'cacheWrite' | 'output'): number =>
      usage.reduce((n, u) => n + u[key], 0)
    // last total of the recording: inputTokens 105060, cachedInputTokens 86144, outputTokens 188
    expect(sum('input')).toBe(105060 - 86144)
    expect(sum('cacheRead')).toBe(86144)
    expect(sum('cacheWrite')).toBe(0)
    expect(sum('output')).toBe(188)
  })

  it.each([
    {
      name: 'cached tokens are carved out of input',
      total: counts(1000, 600, 50),
      last: counts(1000, 600, 50),
      expected: { input: 400, cacheRead: 600, cacheWrite: 0, output: 50, maxCallInput: 1000 }
    },
    {
      name: 'cache writes are carved out of input too',
      total: counts(1000, 600, 50, 100),
      last: counts(1000, 600, 50, 100),
      expected: { input: 300, cacheRead: 600, cacheWrite: 100, output: 50, maxCallInput: 1000 }
    },
    {
      name: 'input never goes negative',
      total: counts(100, 90, 5, 50),
      last: counts(100, 90, 5, 50),
      expected: { input: 0, cacheRead: 90, cacheWrite: 50, output: 5, maxCallInput: 100 }
    },
    {
      name: 'no total: last is the spend',
      total: undefined,
      last: counts(700, 100, 20),
      expected: { input: 600, cacheRead: 100, cacheWrite: 0, output: 20, maxCallInput: 700 }
    }
  ])('maps the buckets: $name', ({ total, last, expected }) => {
    const [event] = usageOf(run([update(total, last)]))
    expect(event).toMatchObject({
      ...expected,
      scope: 'turn',
      turnId: 'turn-1',
      callCount: 1,
      contextWindow: 1000,
      partial: false
    })
  })

  it('uses the delta of total after the first update, and sends firstCall only once', () => {
    const events = usageOf(
      run([
        update(counts(100, 0, 10), counts(100, 0, 10)),
        update(counts(260, 100, 25), counts(160, 100, 15))
      ])
    )
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      input: 100,
      output: 10,
      firstCall: { input: 100, cacheWrite: 0, cacheRead: 0 }
    })
    expect(events[1]).toMatchObject({ input: 60, cacheRead: 100, output: 15, maxCallInput: 160 })
    expect(events[1]?.firstCall).toBeUndefined()
  })

  it('a re-sent identical update is not counted twice (no event at all)', () => {
    const first = update(counts(100, 0, 10), counts(100, 0, 10))
    const events = usageOf(run([first, first, first]))
    expect(events).toHaveLength(1)
  })

  it('after a resume or reset the counter is seeded or goes backwards: last is the spend', () => {
    // A resumed thread: the first update of a fresh parser has a seeded total far above its last.
    const resumed = usageOf(run([update(counts(500_000, 400_000, 9000), counts(5000, 4000, 20))]))
    expect(resumed[0]).toMatchObject({
      input: 1000,
      cacheRead: 4000,
      output: 20,
      maxCallInput: 5000
    })
    // The counter going backwards inside one parser is a reset.
    const reset = usageOf(
      run([
        update(counts(1000, 0, 100), counts(1000, 0, 100)),
        update(counts(300, 0, 30), counts(300, 0, 30)),
        update(counts(500, 0, 50), counts(200, 0, 20))
      ])
    )
    expect(reset.map((e) => [e.input, e.output])).toEqual([
      [1000, 100],
      [300, 30],
      [200, 20]
    ])
  })

  it('keeps a separate running total per thread', () => {
    const events = usageOf(
      run([
        update(counts(100, 0, 10), counts(100, 0, 10), 'a'),
        update(counts(100, 0, 10), counts(100, 0, 10), 'b')
      ])
    )
    expect(events).toHaveLength(2)
  })

  it('trusts the delta and logs at debug when last disagrees with it', () => {
    const debug = vi.fn()
    const events = usageOf(
      run(
        [
          update(counts(100, 0, 10), counts(100, 0, 10)),
          update(counts(400, 0, 40), counts(100, 0, 10))
        ],
        debug
      )
    )
    expect(events[1]).toMatchObject({ input: 300, output: 30, maxCallInput: 100 })
    expect(debug).toHaveBeenCalledTimes(1)
  })
})
