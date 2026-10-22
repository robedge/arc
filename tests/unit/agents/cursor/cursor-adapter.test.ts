import { afterEach, describe, expect, it } from 'vitest'
import {
  ProviderHistoryMissingError,
  ProviderUnavailableError,
  type AgentHandle,
  type CursorStartRequest
} from '../../../../src/main/agents/agent-adapter'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import {
  CursorAdapter,
  CursorHandle,
  optionFor,
  type CursorAdapterDeps,
  type CursorAdapterTimings
} from '../../../../src/main/agents/cursor/cursor-adapter'
import type {
  CursorApprovalHandler,
  CursorApprovalRequest
} from '../../../../src/main/agents/cursor/cursor-types'
import { FakeAcp, until, type Msg } from './fake-acp'
import { loadReplay, promptTurns, serverMessages, turnMessages } from './fixtures'

type Of<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>

const fast: Partial<CursorAdapterTimings> = {
  interruptAckMs: 120,
  sigintMs: 120,
  termMs: 120,
  stopGraceMs: 60,
  stopTermMs: 120,
  requestMs: 2000
}

const handles: AgentHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
})

function options(over: Partial<CursorStartRequest> = {}): CursorStartRequest {
  return {
    provider: 'cursor',
    agentId: 'w1',
    role: 'worker',
    cwd: '/work/w1',
    model: 'default[]',
    access: 'worker-write',
    cursor: {},
    bridge: { url: 'http://127.0.0.1:50607/mcp', token: 'bridge-token' },
    ...over
  }
}

function adapterFor(fake: FakeAcp, over: Partial<CursorAdapterDeps> = {}): CursorAdapter {
  return new CursorAdapter({
    supervisor: fake.supervisor,
    binary: () => 'agent',
    binaryArgs: [],
    resolvePath: () => Promise.resolve('/usr/bin'),
    env: { HOME: '/home/u' },
    timings: fast,
    ...over
  })
}

async function begin(
  fake: FakeAcp,
  over: Partial<CursorStartRequest> = {},
  deps: Partial<CursorAdapterDeps> = {}
): Promise<CursorHandle> {
  const handle = (await adapterFor(fake, deps).start(options(over))) as CursorHandle
  handles.push(handle)
  return handle
}

/** Collects the handle's events in the background. */
function watch(handle: AgentHandle): {
  events: AgentEvent[]
  of: <T extends AgentEvent['type']>(type: T) => Of<T>[]
} {
  const events: AgentEvent[] = []
  void (async () => {
    for await (const e of handle.events) events.push(e)
  })()
  return {
    events,
    of: <T extends AgentEvent['type']>(type: T): Of<T>[] =>
      events.filter((e): e is Of<T> => e.type === type)
  }
}

/** Remembers the prompt requests so a test can answer them when it likes. */
function holdPrompts(fake: FakeAcp): Msg[] {
  const prompts: Msg[] = []
  fake.handlers['session/prompt'] = (msg) => void prompts.push(msg)
  return prompts
}

const promptText = (msg: Msg | undefined): string =>
  String(
    (
      ((msg?.['params'] as Msg | undefined)?.['prompt'] as Msg[] | undefined)?.[0] as
        Msg | undefined
    )?.['text'] ?? ''
  )

describe('CursorAdapter handshake', () => {
  it('runs initialize, authenticate, session/new with Arc bridge, then sets the model, then emits the session', async () => {
    const fake = new FakeAcp()
    const handle = await begin(fake)
    const seen = watch(handle)
    expect(fake.spawned[0]?.args).toEqual(['acp'])
    expect(fake.spawned[0]?.cwd).toBe('/work/w1')
    expect(fake.methods()).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/set_model'
    ])
    expect(fake.received.every((m) => m['jsonrpc'] === '2.0')).toBe(true)
    expect(fake.requests('initialize')[0]?.['params']).toEqual({
      protocolVersion: 1,
      clientCapabilities: {}
    })
    expect(fake.requests('authenticate')[0]?.['params']).toEqual({ methodId: 'cursor_login' })
    expect(fake.requests('session/new')[0]?.['params']).toEqual({
      cwd: '/work/w1',
      mcpServers: [
        {
          type: 'http',
          name: 'arc',
          url: 'http://127.0.0.1:50607/mcp',
          headers: [{ name: 'Authorization', value: 'Bearer bridge-token' }]
        }
      ]
    })
    // The recorded session started on another model; the one asked for is set by its whole id.
    expect(fake.requests('session/set_model')[0]?.['params']).toEqual({
      sessionId: 'session-1',
      modelId: 'default[]'
    })
    await until(() => seen.of('session').length === 1)
    expect(seen.of('session')[0]).toMatchObject({
      provider: 'cursor',
      providerSessionId: 'session-1',
      model: 'default[]',
      permissionMode: 'agent',
      mcpServers: [{ name: 'arc', status: 'configured' }]
    })
    expect(handle.capabilities).toEqual({
      interruptCancelsApprovals: true,
      queuesSendsWhileBusy: true,
      midTurnSteer: false
    })
    expect(handle.provider).toBe('cursor')
    expect(handle.pid).toBe(4242)
  })

  it('runs a brain in ask mode, and starts without Arc tools when there is no bridge', async () => {
    const fake = new FakeAcp()
    await begin(fake, { role: 'brain', access: 'brain-readonly', model: '', bridge: undefined })
    expect(fake.requests('session/new')[0]?.['params']).toEqual({ cwd: '/work/w1', mcpServers: [] })
    expect(fake.requests('session/set_mode')[0]?.['params']).toEqual({
      sessionId: 'session-1',
      modeId: 'ask'
    })
    expect(fake.requests('session/set_model')).toHaveLength(0)
  })

  it('keeps CURSOR_* out of the child env, and the bridge token out of env and argv', async () => {
    const fake = new FakeAcp()
    await begin(
      fake,
      { extraEnv: { CURSOR_API_KEY: 'from-extra', CUSTOM: '1', CURSOR_CONFIG_DIR: '/x' } },
      {
        env: {
          HOME: '/home/u',
          CURSOR_API_KEY: 'secret',
          CURSOR_ANYTHING: 'x',
          ANTHROPIC_API_KEY: 'a',
          HARNESS_E2E: '1',
          FAKE_CURSOR_SCRIPT: '/s.jsonl'
        }
      }
    )
    const spawn = fake.spawned[0]
    const env = spawn?.env ?? {}
    expect(Object.keys(env).filter((k) => k.startsWith('CURSOR_'))).toEqual([])
    expect(env['FAKE_CURSOR_SCRIPT']).toBe('/s.jsonl') // allowed under HARNESS_E2E
    expect(env['CUSTOM']).toBe('1')
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(env['ARC_PROVIDER']).toBe('cursor')
    expect(env['ARC_AGENT_ROLE']).toBe('worker')
    expect(env['ARC_AGENT']).toBe('1')
    expect(JSON.stringify(spawn)).not.toContain('bridge-token')
  })

  it('turns an authentication error into a signed-out provider and stops the process', async () => {
    const fake = new FakeAcp()
    fake.handlers['authenticate'] = (msg, f) => f.error(msg, -32000, 'Authentication required')
    const error = await adapterFor(fake)
      .start(options())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect(error).toMatchObject({ provider: 'cursor', reason: 'signed_out' })
    expect(fake.signals).toContain('SIGTERM')
    expect(fake.methods()).not.toContain('session/new')

    // The login can also vanish between authenticate and session/new.
    const second = new FakeAcp()
    second.handlers['session/new'] = (msg, f) => f.error(msg, -32000, 'Authentication required')
    await expect(adapterFor(second).start(options())).rejects.toMatchObject({
      reason: 'signed_out'
    })
  })

  it('refuses a Cursor older than the minimum before it spawns anything', async () => {
    const fake = new FakeAcp()
    const error = await adapterFor(fake, { version: () => '2026.01.01-abcdef0' })
      .start(options())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect(error).toMatchObject({ reason: 'unsupported' })
    expect(fake.spawned).toHaveLength(0)

    const ok = new FakeAcp()
    await begin(ok, {}, { version: () => Promise.resolve('2026.10.19-6bbf2c4') })
    expect(ok.spawned).toHaveLength(1)
  })

  it('reports a missing binary as a missing provider', async () => {
    const fake = new FakeAcp()
    await expect(
      adapterFor(fake, { binary: () => undefined }).start(options())
    ).rejects.toMatchObject({
      provider: 'cursor',
      reason: 'missing'
    })
    expect(fake.spawned).toHaveLength(0)
  })

  it('refuses another provider’s start', async () => {
    const fake = new FakeAcp()
    await expect(
      adapterFor(fake).start({ ...options(), provider: 'codex', codex: {} } as never)
    ).rejects.toThrow(/cannot start a codex agent/)
  })
})

describe('CursorAdapter resume', () => {
  it('loads the session, drops the replayed history, and keeps the command list', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/load'] = (msg, f) => {
      f.update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'old answer' }
      })
      f.update({
        sessionUpdate: 'tool_call',
        toolCallId: 'old-1',
        title: 'Read x',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/x' }
      })
      f.update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'review', description: 'Review' }]
      })
      f.result(msg, {})
    }
    const handle = await begin(fake, { resume: { threadId: 'session-9' } })
    const seen = watch(handle)
    expect(fake.methods().slice(0, 3)).toEqual(['initialize', 'authenticate', 'session/load'])
    expect(fake.requests('session/new')).toHaveLength(0)
    expect(fake.requests('session/load')[0]?.['params']).toMatchObject({
      sessionId: 'session-9',
      cwd: '/work/w1',
      mcpServers: [{ name: 'arc' }]
    })
    await until(() => seen.of('session').length === 1)
    expect(seen.of('session')[0]).toMatchObject({ providerSessionId: 'session-9' })
    // Nothing of the replay became output...
    fake.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } })
    await until(() => seen.of('text-delta').length === 1)
    expect(seen.of('text-delta')[0]?.text).toBe('new')
    expect(seen.events.some((e) => e.type === 'tool-use')).toBe(false)
    // ...but the command list was kept.
    expect(handle.availableCommands()).toEqual([{ name: 'review', description: 'Review' }])
  })

  it('treats a session Cursor no longer has as a missing history', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/load'] = (msg, f) =>
      f.error(msg, -32602, 'Invalid params', { message: 'Session "session-9" not found' })
    const error = await adapterFor(fake)
      .resume({ ...options(), resume: { threadId: 'session-9' } })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ProviderHistoryMissingError)
    expect(error).toMatchObject({ provider: 'cursor', threadId: 'session-9' })
  })
})

describe('CursorAdapter turns', () => {
  it('puts the instructions in front of the first prompt only', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const handle = await begin(fake, { instructions: 'You are worker W1.' })
    const seen = watch(handle)
    await handle.send('first task')
    await until(() => prompts.length === 1)
    expect(promptText(prompts[0])).toBe(
      '<arc-instructions>\nYou are worker W1.\n</arc-instructions>\n\nfirst task'
    )
    fake.result(prompts[0] as Msg, { stopReason: 'end_turn' })
    await until(() => seen.of('turn-result').length === 1)
    await handle.send('second task')
    await until(() => prompts.length === 2)
    expect(promptText(prompts[1])).toBe('second task')
  })

  it('runs one prompt at a time, queues the rest, and gives each send its own result', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('a')
    await handle.send('b')
    await handle.send('c')
    await until(() => prompts.length === 1)
    await new Promise((r) => setTimeout(r, 40))
    expect(prompts).toHaveLength(1) // b and c wait
    expect(handle.discardQueuedSends()).toEqual(['b', 'c'])
    await handle.send('d')
    fake.result(prompts[0] as Msg, { stopReason: 'end_turn' })
    await until(() => prompts.length === 2)
    expect(promptText(prompts[1])).toBe('d')
    fake.result(prompts[1] as Msg, { stopReason: 'end_turn' })
    await until(() => seen.of('turn-result').length === 2)
    expect(seen.of('turn-started')).toHaveLength(2)
  })

  it('applies a model change before the next prompt, and carries on when Cursor refuses it', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const handle = await begin(fake)
    const seen = watch(handle)
    const before = fake.received.length
    handle.setModel('grok-4.7[context=256k,reasoning_effort=high,fast=true]')
    await handle.send('go')
    await until(() => prompts.length === 1)
    const after = fake.received.slice(before).map((m) => m['method'])
    expect(after).toEqual(['session/set_model', 'session/prompt'])
    expect(fake.received[before]?.['params']).toEqual({
      sessionId: 'session-1',
      modelId: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
    })
    fake.result(prompts[0] as Msg, { stopReason: 'end_turn' })
    await until(() => seen.of('turn-result').length === 1)

    fake.handlers['session/set_model'] = (msg, f) =>
      f.error(msg, -32602, 'Invalid params', { message: 'Invalid model value: nope' })
    handle.setModel('nope')
    await handle.send('again')
    await until(() => prompts.length === 2)
    expect(seen.of('error')[0]).toMatchObject({ kind: 'api' })
    expect(seen.of('error')[0]?.message).toContain('nope')
  })

  it('reports a failed prompt as an error and a failed turn', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/prompt'] = (msg, f) => f.error(msg, -32603, 'Internal error')
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('error')[0]).toMatchObject({ kind: 'api', message: 'Internal error' })
    expect(seen.of('turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
    // The handle still takes the next send.
    fake.handlers['session/prompt'] = (msg, f) => f.result(msg, { stopReason: 'end_turn' })
    await handle.send('again')
    await until(() => seen.of('turn-result').length === 2)
    expect(seen.of('turn-result')[1]?.ok).toBe(true)
  })

  it('ends with the exit event when the process dies mid-turn, and refuses further sends', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => prompts.length === 1)
    fake.exit(1, null)
    await until(() => seen.of('exit').length === 1)
    expect(seen.of('exit')[0]).toMatchObject({ code: 1, expected: false })
    expect(seen.of('turn-result')).toHaveLength(0)
    await expect(handle.send('late')).resolves.toBe(false)
    await expect(handle.interrupt()).resolves.toBe('idle')
  })

  it('stops the process: cancels the turn, closes stdin, then SIGTERM when it lingers', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => prompts.length === 1)
    await handle.stop()
    expect(fake.requests('session/cancel')).toHaveLength(1)
    expect(fake.signals).toEqual(['SIGTERM'])
    await until(() => seen.of('exit').length === 1)
    expect(seen.of('exit')[0]?.expected).toBe(true)
    await handle.stop() // a second stop is harmless
  })
})

describe('CursorAdapter interrupt', () => {
  it('is idle when no turn runs', async () => {
    const fake = new FakeAcp()
    const handle = await begin(fake)
    await expect(handle.interrupt()).resolves.toBe('idle')
    expect(fake.requests('session/cancel')).toHaveLength(0)
  })

  it('cancels the prompt, answers the pending permission request cancelled, and acks when the turn ends', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const aborts: unknown[] = []
    const approvals: CursorApprovalHandler = {
      handle: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborts.push(signal.reason)
            resolve({ decision: 'allow' }) // too late: the request was withdrawn
          })
        })
    }
    const handle = await begin(fake, { cursor: { approvals } })
    const seen = watch(handle)
    await handle.send('go')
    await until(() => prompts.length === 1)
    fake.send({
      id: 0,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tc-1', title: '`git push`', kind: 'execute', status: 'pending' },
        options: [
          { optionId: 'allow-once', kind: 'allow_once' },
          { optionId: 'reject-once', kind: 'reject_once' }
        ]
      }
    })
    await until(() => seen.of('approval').length === 1)

    const outcome = handle.interrupt()
    await until(() => fake.requests('session/cancel').length === 1)
    // `session/cancel` is a notification: it has no id.
    expect(fake.requests('session/cancel')[0]).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'session-1' }
    })
    fake.result(prompts[0] as Msg, { stopReason: 'cancelled' })
    await expect(outcome).resolves.toBe('acked')
    expect(fake.answers()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } }
    ])
    expect(aborts).toEqual(['withdrawn'])
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('turn-result')[0]).toMatchObject({ interrupted: true, status: 'interrupted' })
    // The late allow was not sent as a second answer.
    await until(() => seen.of('approval').length === 2)
    expect(seen.of('approval')[1]).toMatchObject({ state: 'resolved', decision: 'cancelled' })
    expect(fake.answers()).toHaveLength(1)
  })

  it('escalates to SIGINT when the turn does not end after the cancel', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    fake.exitOn = new Set()
    fake.onSignal = (signal) => {
      if (signal === 'SIGINT') fake.result(prompts[0] as Msg, { stopReason: 'cancelled' })
    }
    const handle = await begin(fake)
    await handle.send('go')
    await until(() => prompts.length === 1)
    await expect(handle.interrupt()).resolves.toBe('sigint')
    expect(fake.signals).toEqual(['SIGINT'])
    fake.exitOn = new Set(['SIGTERM']) // so the cleanup can end the process
  })

  it('kills the process (SIGINT, SIGTERM, SIGKILL) when nothing else ends the turn', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    fake.exitOn = new Set(['SIGKILL'])
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => prompts.length === 1)
    await expect(handle.interrupt()).resolves.toBe('killed')
    expect(fake.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL'])
    await until(() => seen.of('exit').length === 1)
  })

  it('ends a turn that was interrupted before its prompt went out without sending the prompt', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    let release: (() => void) | undefined
    const handle = await begin(fake)
    fake.handlers['session/set_model'] = (msg, f) => {
      release = () => f.result(msg, {})
    }
    const seen = watch(handle)
    handle.setModel('slow-model[]')
    await handle.send('go')
    await until(() => release !== undefined)
    const outcome = handle.interrupt()
    release?.()
    await expect(outcome).resolves.toBe('acked')
    expect(prompts).toHaveLength(0)
    expect(fake.requests('session/cancel')).toHaveLength(0)
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('turn-result')[0]?.interrupted).toBe(true)
  })
})

/** Permission requests in the shape the M1 recording has. */
function permission(
  id: number,
  toolCallId: string,
  options: { optionId: string; kind: string }[] = [
    { optionId: 'allow-once', kind: 'allow_once' },
    { optionId: 'allow-always', kind: 'allow_always' },
    { optionId: 'reject-once', kind: 'reject_once' }
  ]
): Msg {
  return {
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'session-1',
      toolCall: { toolCallId, title: '`ls`', kind: 'execute', status: 'pending' },
      options
    }
  }
}

describe('CursorAdapter permission requests', () => {
  it('rejects once when no approval handler is set, by option kind', async () => {
    const fake = new FakeAcp()
    const handle = await begin(fake)
    const seen = watch(handle)
    fake.send(permission(0, 'tc-1'))
    await until(() => fake.answers().length === 1)
    expect(fake.answers()[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
    await until(() => seen.of('approval').length === 2)
    expect(seen.of('approval')[0]).toMatchObject({
      state: 'requested',
      summary: '`ls`',
      approvalId: '0'
    })
    expect(seen.of('approval')[1]).toMatchObject({ state: 'resolved', decision: 'deny' })
  })

  it('answers allow-once for an allow, picks options by kind and never allow-always', async () => {
    const fake = new FakeAcp()
    const approvals: CursorApprovalHandler = {
      handle: (request) =>
        Promise.resolve({ decision: request.toolCallId === 'tc-allow' ? 'allow' : 'reject' })
    }
    await begin(fake, { cursor: { approvals } })
    // Option ids are not what the code keys on: only the kinds.
    const odd = [
      { optionId: 'opt-a', kind: 'allow_always' },
      { optionId: 'opt-b', kind: 'allow_once' },
      { optionId: 'opt-c', kind: 'reject_once' }
    ]
    fake.send(permission(0, 'tc-allow', odd))
    await until(() => fake.answers().length === 1)
    fake.send(permission(1, 'tc-deny', odd))
    await until(() => fake.answers().length === 2)
    // Only allow_always is on offer for an allow: it is refused, not granted.
    fake.send(permission(2, 'tc-allow', [{ optionId: 'x', kind: 'allow_always' }]))
    await until(() => fake.answers().length === 3)
    const chosen = fake.answers().map((a) => (a['result'] as Msg)['outcome'])
    expect(chosen).toEqual([
      { outcome: 'selected', optionId: 'opt-b' },
      { outcome: 'selected', optionId: 'opt-c' },
      { outcome: 'cancelled' }
    ])
  })

  it('puts the reason for a rejected request in front of the next prompt, once', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const approvals: CursorApprovalHandler = {
      handle: () =>
        Promise.resolve({
          decision: 'reject',
          message: 'Your request to run `git push` was declined: the user said no.'
        })
    }
    const handle = await begin(fake, { cursor: { approvals } })
    const seen = watch(handle)
    await handle.send('first')
    await until(() => prompts.length === 1)
    expect(promptText(prompts[0])).toBe('first')
    fake.send(permission(0, 'tc-1'))
    await until(() => fake.answers().length === 1)
    fake.send({ id: prompts[0]?.['id'] as number, result: { stopReason: 'end_turn' } })
    await until(() => seen.of('turn-result').length === 1)
    await handle.send('second')
    await until(() => prompts.length === 2)
    expect(promptText(prompts[1])).toBe(
      "[Arc] Your request to run `git push` was declined: the user said no. Don't work around it; call ask_brain.\n\nsecond"
    )
    fake.send({ id: prompts[1]?.['id'] as number, result: { stopReason: 'end_turn' } })
    await until(() => seen.of('turn-result').length === 2)
    await handle.send('third')
    await until(() => prompts.length === 3)
    expect(promptText(prompts[2])).toBe('third')
  })

  it('refuses when the handler throws, and answers cancelled for a cancel decision', async () => {
    const fake = new FakeAcp()
    let n = 0
    const approvals: CursorApprovalHandler = {
      handle: () => {
        n += 1
        return n === 1 ? Promise.reject(new Error('boom')) : Promise.resolve({ decision: 'cancel' })
      }
    }
    await begin(fake, { cursor: { approvals } })
    fake.send(permission(0, 'a'))
    await until(() => fake.answers().length === 1)
    fake.send(permission(1, 'b'))
    await until(() => fake.answers().length === 2)
    expect(fake.answers().map((a) => (a['result'] as Msg)['outcome'])).toEqual([
      { outcome: 'selected', optionId: 'reject-once' },
      { outcome: 'cancelled' }
    ])
  })

  it('answers a request it cannot read cancelled, and any other server request method-not-found', async () => {
    const fake = new FakeAcp()
    await begin(fake)
    fake.send({ id: 3, method: 'session/request_permission', params: { nonsense: true } })
    fake.send({ id: 4, method: 'fs/read_text_file', params: { path: '/etc/hosts' } })
    await until(() => fake.received.filter((m) => m['method'] === undefined).length === 2)
    const byId = new Map(
      fake.received.filter((m) => m['method'] === undefined).map((m) => [m['id'], m])
    )
    expect(byId.get(3)?.['result']).toEqual({ outcome: { outcome: 'cancelled' } })
    expect(byId.get(4)?.['error']).toMatchObject({ code: -32601 })
  })
})

describe('optionFor', () => {
  const all = [
    { optionId: 'a', kind: 'allow_once' },
    { optionId: 'b', kind: 'allow_always' },
    { optionId: 'c', kind: 'reject_once' }
  ]
  it('chooses allow_once and reject_once, and nothing for a cancel', () => {
    expect(optionFor(all, 'allow')).toEqual({ optionId: 'a', allowed: true })
    expect(optionFor(all, 'reject')).toEqual({ optionId: 'c', allowed: false })
    expect(optionFor(all, 'cancel')).toBeUndefined()
    expect(optionFor([all[1] as never], 'allow')).toBeUndefined()
    expect(optionFor([all[0] as never], 'reject')).toBeUndefined()
  })
})

describe('CursorAdapter on the recorded turns', () => {
  it('replays the M1 agent turn: output, tool calls, four permission requests and the turn result', async () => {
    const fake = new FakeAcp()
    const requests: CursorApprovalRequest[] = []
    const approvals: CursorApprovalHandler = {
      handle: (request) => {
        requests.push(request)
        const command = String(request.tool?.rawInput['command'] ?? '')
        return Promise.resolve({ decision: command === 'ls' ? 'reject' : 'allow' })
      }
    }
    fake.handlers['session/prompt'] = (msg, f) => {
      // Cursor sent its command list right after session/new, before the prompt.
      for (const m of serverMessages('m1-agent-turn.jsonl')) {
        if (JSON.stringify(m).includes('available_commands_update')) f.send(m)
      }
      for (const m of turnMessages('m1-agent-turn.jsonl')) {
        if ('result' in m && m['id'] === 5) f.send({ id: msg['id'], result: m['result'] })
        else f.send(m)
      }
    }
    const handle = await begin(fake, { cursor: { approvals } })
    const seen = watch(handle)
    await handle.send('This is a test harness.')
    await until(() => seen.of('turn-result').length === 1, 5000)

    // Text, tool calls and the end of the turn.
    expect(seen.of('text-delta').length).toBe(35)
    expect(seen.of('tool-use').map((e) => e.name)).toEqual([
      'Read',
      'Edit',
      'Bash',
      'Bash',
      'Bash',
      'Read',
      'mcp__arc__echo',
      'mcp__arc__slow'
    ])
    expect(seen.of('tool-result')).toHaveLength(8)
    expect(seen.of('turn-result')[0]).toMatchObject({ ok: true, status: 'completed' })
    expect(seen.of('usage')).toHaveLength(0)
    expect(seen.of('unknown')).toHaveLength(0)

    // The four permission requests reached the hook, each with the tool call that preceded it.
    expect(requests.map((r) => [r.requestId, r.toolCallId, r.kind])).toEqual([
      [0, 'toolcall-4', 'execute'],
      [1, 'toolcall-5', 'execute'],
      [2, 'toolcall-8', 'other'],
      [3, 'toolcall-9', 'other']
    ])
    expect(requests[0]).toMatchObject({
      title: '`git status`',
      sessionId: 'session-1',
      tool: { rawInput: { command: 'git status' } }
    })
    expect(requests[0]?.options.map((o) => o.kind)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once'
    ])
    expect(requests[2]?.tool?.rawInput).toMatchObject({
      providerIdentifier: 'arc',
      toolName: 'echo'
    })

    // And each got its answer by option kind: ids 0 to 3, the ls rejected, none allow-always.
    const answers = fake.answers().map((a) => [a['id'], (a['result'] as Msg)['outcome']])
    expect(answers).toEqual([
      [0, { outcome: 'selected', optionId: 'allow-once' }],
      [1, { outcome: 'selected', optionId: 'reject-once' }],
      [2, { outcome: 'selected', optionId: 'allow-once' }],
      [3, { outcome: 'selected', optionId: 'allow-once' }]
    ])
    expect(
      seen
        .of('approval')
        .filter((a) => a.state === 'resolved')
        .map((a) => a.decision)
    ).toEqual(['allow', 'deny', 'allow', 'allow'])
    expect(handle.availableCommands().map((c) => c.name)).toEqual([
      'copy-request-id',
      'multi-model-review',
      'simplify'
    ])
  })

  it('replays the plan-blocked turn as a rate-limit error that the gate can act on', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/prompt'] = (msg, f) => {
      for (const m of turnMessages('m1-plan-blocked-turn.jsonl')) {
        if ('result' in m) f.send({ id: msg['id'], result: m['result'] })
        else f.send(m)
      }
    }
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('error')).toMatchObject([
      { kind: 'rate-limit', message: 'Upgrade your plan to continue' }
    ])
    expect(seen.of('turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
    expect(seen.of('assistant-message')).toHaveLength(0)
  })

  it('replays a synthetic JSON-RPC rate-limit error as a rate-limit error with no reset time', async () => {
    const fake = new FakeAcp()
    fake.handlers['session/prompt'] = (msg, f) => {
      for (const m of turnMessages('synthetic-rate-limit-error-turn.jsonl')) {
        if ('error' in m) f.send({ id: msg['id'], error: m['error'] })
        else f.send(m)
      }
    }
    const handle = await begin(fake)
    const seen = watch(handle)
    await handle.send('go')
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('error')).toMatchObject([
      { kind: 'rate-limit', message: expect.stringContaining('Rate limit exceeded') as unknown }
    ])
    expect(seen.of('error')[0]).not.toHaveProperty('resetsAt')
    expect(seen.of('turn-result')[0]).toMatchObject({ ok: false, status: 'failed' })
  })
})

describe('CursorAdapter on the M3 and M4 recordings', () => {
  it('M3: session/cancel with a permission pending ends the prompt cancelled, and the session takes a new prompt', async () => {
    const fake = new FakeAcp()
    const prompts = holdPrompts(fake)
    const [first, second] = promptTurns('m3-cancel-turn.jsonl')
    if (!first || !second) throw new Error('the M3 fixture holds two prompts')
    const approvals: CursorApprovalHandler = {
      // The user (or Arc) has not decided when the interrupt comes.
      handle: (_request, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ decision: 'allow' }))
        )
    }
    const handle = await begin(fake, { cursor: { approvals } })
    const seen = watch(handle)

    await handle.send('git status, then git log')
    await until(() => prompts.length === 1)
    for (const m of first) if (!('result' in m)) fake.send(m)
    await until(() => seen.of('approval').length === 1)
    expect(seen.of('tool-use').map((e) => e.name)).toEqual(['Bash'])

    const outcome = handle.interrupt()
    await until(() => fake.requests('session/cancel').length === 1)
    // Real Cursor answered the open prompt at once with `cancelled` (2 ms in the recording), sending
    // nothing for the permission request it had asked.
    const cancelled = first.at(-1)
    expect(cancelled).toMatchObject({ result: { stopReason: 'cancelled' } })
    fake.result(prompts[0] as Msg, cancelled?.['result'])
    await expect(outcome).resolves.toBe('acked')
    await until(() => seen.of('turn-result').length === 1)
    expect(seen.of('turn-result')[0]).toMatchObject({ interrupted: true, status: 'interrupted' })
    // The request Cursor never withdrew is answered cancelled (and never allowed).
    expect(fake.answers()).toEqual([
      { jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'cancelled' } } }
    ])
    expect(seen.of('approval').at(-1)).toMatchObject({ state: 'resolved', decision: 'cancelled' })

    // The same session, a new prompt: "ok".
    await handle.send('Reply with the word ok.')
    await until(() => prompts.length === 2)
    for (const m of second) if (!('result' in m)) fake.send(m)
    fake.result(prompts[1] as Msg, second.at(-1)?.['result'])
    await until(() => seen.of('turn-result').length === 2)
    expect(seen.of('turn-result')[1]).toMatchObject({ ok: true, status: 'completed' })
    expect(
      seen
        .of('text-delta')
        .map((e) => e.text)
        .join('')
    ).toContain('ok')
    expect(fake.requests('session/cancel')).toHaveLength(1)
  })

  it('M4: session/load in a new process drops the replayed history, then the session answers with its memory', async () => {
    const fake = new FakeAcp()
    const { replay, result } = loadReplay('m4-load-turn.jsonl', 'B')
    // Cursor replays the prompt, the thinking and the answer of the earlier turn before it answers the load.
    expect(
      replay.map((m) => (m['params'] as Msg)['update'] as Msg).map((u) => u['sessionUpdate'])
    ).toEqual(['user_message_chunk', 'agent_thought_chunk', 'agent_message_chunk'])
    fake.handlers['session/load'] = (msg, f) => {
      for (const m of replay) f.send(m)
      f.result(msg, result)
    }
    const prompts = holdPrompts(fake)
    const handle = await begin(fake, { resume: { threadId: 'session-1' } })
    const seen = watch(handle)
    await until(() => seen.of('session').length === 1)
    expect(seen.of('session')[0]).toMatchObject({ providerSessionId: 'session-1' })
    // None of the replay (the old "ok") became output.
    expect(seen.events.filter((e) => e.type !== 'session' && e.type !== 'stderr')).toEqual([])

    const [turn] = promptTurns('m4-load-turn.jsonl', 'B')
    if (!turn) throw new Error('the M4 fixture holds a prompt in process B')
    await handle.send('What word did I ask you to remember? Reply with just the word.')
    await until(() => prompts.length === 1)
    for (const m of turn) if (!('result' in m)) fake.send(m)
    fake.result(prompts[0] as Msg, turn.at(-1)?.['result'])
    await until(() => seen.of('turn-result').length === 1)
    expect(
      seen
        .of('text-delta')
        .map((e) => e.text)
        .join('')
    ).toBe('kiwi')
    expect(fake.requests('session/new')).toHaveLength(0)
  })
})
