import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  ProviderHistoryMissingError,
  ProviderUnavailableError,
  type AgentHandle,
  type CodexStartRequest
} from '../../../../src/main/agents/agent-adapter'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import {
  CodexAdapter,
  type CodexAdapterTimings
} from '../../../../src/main/agents/codex/codex-adapter'
import {
  APPROVAL_WITHDRAWN,
  type ApprovalHandler,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from '../../../../src/main/agents/codex/codex-types'
import { ProcessSupervisor } from '../../../../src/main/agents/process-supervisor'
import { startStubBridge, type StubBridge } from './stub-bridge'

const fake = resolve('tests/e2e/fixtures/fake-codex.mjs')
const scenarios = resolve('tests/e2e/fixtures/codex-scenarios')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }

let dir: string
const handles: AgentHandle[] = []
const bridges: StubBridge[] = []
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-codex-adapter-')))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  await Promise.all(bridges.splice(0).map((b) => b.close()))
})

const fastTimings: Partial<CodexAdapterTimings> = {
  interruptAckMs: 400,
  sigintMs: 300,
  termMs: 300,
  stopGraceMs: 400,
  stopTermMs: 300,
  requestMs: 5000,
  mcpReadyMs: 1500
}

function adapterFor(
  over: { binary?: string; binaryArgs?: string[]; minVersion?: string } = {}
): CodexAdapter {
  return new CodexAdapter({
    supervisor: new ProcessSupervisor(),
    binary: over.binary ?? process.execPath,
    binaryArgs: over.binaryArgs ?? [fake],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    timings: fastTimings,
    clientVersion: '9.9.9',
    ...(over.minVersion ? { minVersion: over.minVersion } : {})
  })
}

let counter = 0
/** A script file in the temp dir. */
function scenario(steps: unknown[]): string {
  const p = join(dir, `scenario-${++counter}.jsonl`)
  writeFileSync(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return p
}

function logPath(): string {
  return join(dir, `log-${++counter}.jsonl`)
}

function readLog(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** The client lines the fake received, in order. */
function received(
  log: Record<string, unknown>[]
): { id?: unknown; method?: string; params?: Record<string, unknown>; result?: unknown }[] {
  return log.flatMap((r) =>
    r['recv'] && typeof r['recv'] === 'object' ? [r['recv'] as never] : []
  )
}

function options(over: Partial<CodexStartRequest> = {}): CodexStartRequest {
  return {
    provider: 'codex',
    agentId: 'w1',
    role: 'worker',
    cwd: dir,
    model: 'fake-deep',
    access: 'worker-write',
    codex: {},
    ...over,
    extraEnv: { ...nodeEnv, ...over.extraEnv }
  }
}

async function begin(
  script: string | undefined,
  over: Partial<CodexStartRequest> = {},
  env: Record<string, string> = {},
  adapter: CodexAdapter = adapterFor()
): Promise<{ handle: AgentHandle; log: string }> {
  const log = logPath()
  const handle = await adapter.start(
    options({
      ...over,
      extraEnv: {
        FAKE_CODEX_LOG: log,
        ...(script ? { FAKE_CODEX_SCRIPT: script } : {}),
        ...env,
        ...over.extraEnv
      }
    })
  )
  handles.push(handle)
  return { handle, log }
}

/** Collects events in the background and lets a test wait for one. */
function watch(handle: AgentHandle): {
  events: AgentEvent[]
  waitFor: (pred: (e: AgentEvent) => boolean, label?: string) => Promise<AgentEvent>
  turnResults: () => AgentEvent[]
} {
  const events: AgentEvent[] = []
  void (async () => {
    for await (const e of handle.events) events.push(e)
  })()
  const waitFor = async (
    pred: (e: AgentEvent) => boolean,
    label = 'event'
  ): Promise<AgentEvent> => {
    const deadline = Date.now() + 8000
    for (;;) {
      const hit = events.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}; saw ${events.map((e) => e.type).join(',')}`
        )
      }
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { events, waitFor, turnResults: () => events.filter((e) => e.type === 'turn-result') }
}

const isType =
  (type: AgentEvent['type']) =>
  (e: AgentEvent): boolean =>
    e.type === type

/** The nth turn-result (1-based). */
async function nthTurnResult(w: ReturnType<typeof watch>, n: number): Promise<void> {
  const deadline = Date.now() + 8000
  while (w.turnResults().length < n) {
    if (Date.now() > deadline)
      throw new Error(`turn ${n} never ended; saw ${w.events.map((e) => e.type)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('CodexAdapter handshake', () => {
  it('initializes, checks the version and the account, starts the thread and waits for the arc server', async () => {
    const bridge = await startStubBridge()
    bridges.push(bridge)
    const { handle, log } = await begin(
      undefined,
      {
        bridge: { url: bridge.url, token: bridge.token },
        bridgeTools: ['report_done'],
        instructions: 'You are a worker. [arc-role:worker]',
        extraEnv: { OPENAI_API_KEY: 'sk-never', CODEX_API_KEY: 'never' }
      },
      {}
    )
    const w = watch(handle)
    const session = await w.waitFor(isType('session'), 'session')
    expect(session).toMatchObject({
      provider: 'codex',
      model: 'fake-deep',
      mcpServers: [{ name: 'arc', status: 'ready' }]
    })
    expect((session as { providerSessionId: string }).providerSessionId).toMatch(/^fake-thread-/)
    expect(handle).toMatchObject({
      provider: 'codex',
      capabilities: {
        interruptCancelsApprovals: true,
        queuesSendsWhileBusy: true,
        midTurnSteer: true
      }
    })

    const sent = received(readLog(log))
    expect(sent.map((m) => m.method)).toEqual([
      'initialize',
      'initialized',
      'account/read',
      'thread/start'
    ])
    expect(sent[0]?.params).toEqual({
      clientInfo: { name: 'arc', title: 'Arc', version: '9.9.9' },
      capabilities: { experimentalApi: true }
    })
    expect(sent[2]?.params).toEqual({ refreshToken: false })
    const thread = sent[3]?.params as Record<string, unknown>
    expect(thread).toMatchObject({
      cwd: dir,
      model: 'fake-deep',
      modelProvider: 'openai',
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: 'workspace-write',
      developerInstructions: 'You are a worker. [arc-role:worker]'
    })
    expect(thread).not.toHaveProperty('baseInstructions')
    const arc = (thread['config'] as { mcp_servers: { arc: Record<string, unknown> } }).mcp_servers
      .arc
    expect(arc).toMatchObject({
      url: bridge.url,
      bearer_token_env_var: 'ARC_BRIDGE_TOKEN',
      required: true,
      startup_timeout_sec: 20,
      tool_timeout_sec: 86400,
      default_tools_approval_mode: 'approve',
      enabled_tools: ['report_done']
    })
    expect(JSON.stringify(sent)).not.toContain(bridge.token)
  })

  it('gives the agent the Arc env and none of the API-key env', async () => {
    const { handle, log } = await begin(
      undefined,
      {
        role: 'brain',
        access: 'brain-readonly',
        bridge: { url: 'http://127.0.0.1:1/mcp', token: 'tok-1' },
        extraEnv: {
          OPENAI_API_KEY: 'sk-never',
          OPENAI_BASE_URL: 'http://x',
          CODEX_API_KEY: 'never'
        }
      },
      { FAKE_CODEX_ARC_STATUS: 'ready' }
    )
    await watch(handle).waitFor(isType('session'))
    const record = readLog(log).find((r) => r['env'])?.['env'] as {
      keys: string[]
      ARC_AGENT: string
      ARC_AGENT_ROLE: string
      ARC_PROVIDER: string
      hasBridgeToken: boolean
    }
    expect(record).toMatchObject({
      ARC_AGENT: '1',
      ARC_AGENT_ROLE: 'brain',
      ARC_PROVIDER: 'codex',
      hasBridgeToken: true
    })
    expect(record.keys.filter((k) => /^OPENAI_|^CODEX_|ANTHROPIC/.test(k))).toEqual([])
  })

  it('resumes a thread with the same overrides', async () => {
    const { handle, log } = await begin(undefined, {
      resume: { threadId: 'thr-old' },
      instructions: 'Again.'
    })
    const session = await watch(handle).waitFor(isType('session'))
    expect(session).toMatchObject({ providerSessionId: 'thr-old' })
    const resume = received(readLog(log)).find((m) => m.method === 'thread/resume')
    expect(resume?.params).toMatchObject({
      threadId: 'thr-old',
      excludeTurns: true,
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      developerInstructions: 'Again.'
    })
  })

  it('rejects a failed resume, and a bridge that never comes up, and leaves no process', async () => {
    await expect(
      begin(undefined, { resume: { threadId: 'gone' } }, { FAKE_CODEX_RESUME_FAIL: '1' })
    ).rejects.toThrow(/thread not found/)
    // ... and says so with a type the caller can act on
    const missing = await begin(
      undefined,
      { resume: { threadId: 'gone' } },
      { FAKE_CODEX_RESUME_FAIL: '1' }
    ).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(ProviderHistoryMissingError)
    expect(missing).toMatchObject({ provider: 'codex', threadId: 'gone' })
    await expect(
      begin(
        undefined,
        { bridge: { url: 'http://127.0.0.1:1/mcp', token: 't' } },
        { FAKE_CODEX_ARC_STATUS: 'failed' }
      )
    ).rejects.toThrow(/arc MCP server failed to start: fake-codex: could not reach the bridge/)
    await expect(
      begin(
        undefined,
        { bridge: { url: 'http://127.0.0.1:1/mcp', token: 't' } },
        { FAKE_CODEX_ARC_STATUS: 'never' }
      )
    ).rejects.toThrow(/did not start in time/)
  })

  it('rejects with ProviderUnavailableError for a signed-out, an old and a missing Codex', async () => {
    const signedOut = await begin(undefined, {}, { FAKE_CODEX_AUTH: 'signed_out' }).catch(
      (e: unknown) => e
    )
    expect(signedOut).toBeInstanceOf(ProviderUnavailableError)
    expect(signedOut).toMatchObject({ provider: 'codex', reason: 'signed_out' })

    const old = await begin(undefined, {}, { FAKE_CODEX_VERSION: '0.100.0' }).catch(
      (e: unknown) => e
    )
    expect(old).toMatchObject({ reason: 'unsupported' })

    const missing = await begin(
      undefined,
      {},
      {},
      adapterFor({ binary: join(dir, 'no-such-codex'), binaryArgs: [] })
    ).catch((e: unknown) => e)
    expect(missing).toBeInstanceOf(ProviderUnavailableError)
    expect(missing).toMatchObject({ reason: 'missing' })
  })

  it('accepts an API-key login', async () => {
    const { handle } = await begin(undefined, {}, { FAKE_CODEX_AUTH: 'api_key' })
    await watch(handle).waitFor(isType('session'))
  })

  it('refuses to start a Claude agent', async () => {
    await expect(
      adapterFor().start({
        provider: 'claude',
        agentId: 'x',
        role: 'worker',
        cwd: dir,
        model: 'm',
        access: 'worker-write',
        claude: {}
      })
    ).rejects.toThrow(/cannot start a claude agent/)
  })
})

describe('CodexAdapter turns', () => {
  it('sends a user message as turn/start and streams the turn', async () => {
    const script = scenario([
      { expect: 'turn/start', text: 'hello' },
      { turnStarted: true },
      { say: 'hi there' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    expect(await handle.send('hello')).toBe(true)
    await nthTurnResult(w, 1)
    // (Codex's own account/updated notification arrives as an unknown event during the handshake.)
    expect(w.events.map((e) => e.type).filter((t) => t !== 'unknown')).toEqual([
      'session',
      'turn-started',
      'text-delta',
      'assistant-message',
      'usage',
      'turn-result'
    ])
    expect(w.events.find(isType('assistant-message'))).toMatchObject({ text: 'hi there' })
    expect(w.events.at(-1)).toMatchObject({ ok: true, status: 'completed', turnId: 'fake-turn-1' })
    const start = received(readLog(log)).find((m) => m.method === 'turn/start')
    expect(start?.params).toEqual({
      threadId: expect.stringMatching(/^fake-thread-/) as string,
      input: [{ type: 'text', text: 'hello' }]
    })
  })

  it('reports usage as the delta of the thread total: two updates, a duplicate dropped, cumulative across turns', async () => {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { say: 'a' },
      { turnCompleted: 'completed', usageUpdates: 2, duplicateUsage: true },
      { expect: 'turn/start' },
      { turnStarted: true },
      { say: 'b' },
      { turnCompleted: 'completed' }
    ])
    const { handle } = await begin(script)
    const w = watch(handle)
    expect(await handle.send('one')).toBe(true)
    await nthTurnResult(w, 1)
    expect(await handle.send('two')).toBe(true)
    await nthTurnResult(w, 2)
    const usage = w.events.filter(
      (e): e is Extract<AgentEvent, { type: 'usage' }> => e.type === 'usage'
    )
    // fake request: input 120 including 40 cached, output 30
    expect(usage.map((u) => [u.input, u.cacheRead, u.output, u.maxCallInput])).toEqual([
      [80, 40, 30, 120],
      [80, 40, 30, 120],
      [80, 40, 30, 120]
    ])
    expect(usage[0]?.firstCall).toEqual({ input: 80, cacheWrite: 0, cacheRead: 40 })
    expect(usage[1]?.firstCall).toBeUndefined()
  })

  it('sends a skill as [{type:skill},{type:text}] turn input, queued like any other send', async () => {
    const script = scenario([
      { expect: 'turn/start', text: 'first' },
      { turnStarted: true },
      { turnCompleted: 'completed' },
      { expect: 'turn/start', text: 'now' },
      { turnStarted: true },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    if (!handle.sendInput) throw new Error('a Codex handle sends structured input')
    expect(await handle.send('first')).toBe(true)
    expect(
      await handle.sendInput([
        { type: 'skill', name: 'publish-release', path: '/s/publish-release/SKILL.md' },
        { type: 'text', text: 'now' }
      ])
    ).toBe(true)
    await nthTurnResult(w, 2)
    const starts = received(readLog(log)).filter((m) => m.method === 'turn/start')
    expect(starts.map((m) => (m.params as { input: unknown }).input)).toEqual([
      [{ type: 'text', text: 'first' }],
      [
        { type: 'skill', name: 'publish-release', path: '/s/publish-release/SKILL.md' },
        { type: 'text', text: 'now' }
      ]
    ])
  })

  it('sends a model change with the turns that start after it (turn/start.model)', async () => {
    const script = scenario([
      { expect: 'turn/start', text: 'one' },
      { turnStarted: true },
      { turnCompleted: 'completed' },
      { expect: 'turn/start', text: 'two' },
      { turnStarted: true },
      { turnCompleted: 'completed' },
      { expect: 'turn/start', text: 'three' },
      { turnStarted: true },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    await handle.send('one')
    await nthTurnResult(w, 1)
    handle.setModel?.('gpt-next')
    await handle.send('two')
    await nthTurnResult(w, 2)
    await handle.send('three')
    await nthTurnResult(w, 3)
    const starts = received(readLog(log)).filter((m) => m.method === 'turn/start')
    expect(starts.map((m) => m.params?.model)).toEqual([undefined, 'gpt-next', 'gpt-next'])
  })

  it('queues sends while a turn runs and starts them one at a time, each with its own result', async () => {
    const script = scenario([
      { expect: 'turn/start', text: 'one' },
      { turnStarted: true },
      { sleep: 250 },
      { say: 'first' },
      { turnCompleted: 'completed' },
      { expect: 'turn/start', text: 'two' },
      { turnStarted: true },
      { say: 'second' },
      { turnCompleted: 'completed' },
      { expect: 'turn/start', text: 'three' },
      { turnStarted: true },
      { say: 'third' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    expect(await handle.send('one')).toBe(true)
    // the first turn is still running: these two wait
    expect(await handle.send('two')).toBe(true)
    expect(await handle.send('three')).toBe(true)
    await nthTurnResult(w, 3)

    expect(
      w.events.filter(isType('assistant-message')).map((e) => (e as { text: string }).text)
    ).toEqual(['first', 'second', 'third'])
    // Order on the wire: a turn/start goes out only after the previous turn/completed came in.
    const trace = readLog(log).flatMap((r) => {
      const recv = r['recv'] as
        { method?: string; params?: { input?: { text: string }[] } } | undefined
      if (recv?.method === 'turn/start') return [`start:${recv.params?.input?.[0]?.text}`]
      const send = r['send'] as { method?: string } | undefined
      return send?.method === 'turn/completed' ? ['completed'] : []
    })
    expect(trace).toEqual([
      'start:one',
      'completed',
      'start:two',
      'completed',
      'start:three',
      'completed'
    ])
  })

  it('reports a failed turn: the error, then the failed result', async () => {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { turnCompleted: 'failed', error: 'model overloaded' }
    ])
    const { handle } = await begin(script)
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)
    expect(w.events.filter((e) => e.type === 'error' || e.type === 'turn-result')).toEqual([
      expect.objectContaining({ type: 'error', kind: 'api', message: 'model overloaded' }),
      expect.objectContaining({
        type: 'turn-result',
        ok: false,
        status: 'failed',
        turnId: 'fake-turn-1'
      })
    ])
  })

  it('reports a rejected turn/start as an error and a failed result, then serves the queue', async () => {
    const script = scenario([
      { expect: 'turn/start', text: 'one', responseDelayMs: 100, fail: 'no capacity' },
      { expect: 'turn/start', text: 'two' },
      { turnStarted: true },
      { say: 'second' },
      { turnCompleted: 'completed' }
    ])
    const { handle } = await begin(script)
    const w = watch(handle)
    await handle.send('one')
    await handle.send('two') // queued behind the starting turn
    await nthTurnResult(w, 2)
    expect(w.turnResults().map((e) => (e as { status: string }).status)).toEqual([
      'failed',
      'completed'
    ])
    expect(w.events.find(isType('error'))).toMatchObject({
      kind: 'api',
      message: expect.stringContaining('no capacity') as string
    })
  })

  it('send resolves false once the process is gone', async () => {
    const { handle } = await begin(scenario([{ exit: 0 }]))
    const w = watch(handle)
    await w.waitFor(isType('exit'))
    expect(await handle.send('late')).toBe(false)
    expect(await handle.interrupt()).toBe('idle')
  })

  it('steers text into the running turn, and refuses when no turn runs', async () => {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { sleep: 400 },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    const codex = handle as AgentHandle & { steer(text: string): Promise<boolean> }
    expect(await codex.steer('too early')).toBe(false)
    await handle.send('go')
    await w.waitFor(isType('turn-started'))
    expect(await codex.steer('[Arc] change course')).toBe(true)
    const steer = received(readLog(log)).find((m) => m.method === 'turn/steer')
    expect(steer?.params).toMatchObject({
      expectedTurnId: 'fake-turn-1',
      input: [{ type: 'text', text: '[Arc] change course' }]
    })
    await nthTurnResult(w, 1)
    expect(await codex.steer('too late')).toBe(false)
  })
})

describe('CodexAdapter interrupt', () => {
  const busy = (): string =>
    scenario([
      { expect: 'turn/start', responseDelayMs: 300 },
      { turnStarted: true },
      { say: 'working' },
      { sleep: 60_000 },
      { turnCompleted: 'completed' },
      { expect: 'turn/start' },
      { turnStarted: true },
      { say: 'after' },
      { turnCompleted: 'completed' }
    ])

  it('waits for a starting turn to learn its id before interrupting it (the race)', async () => {
    const { handle, log } = await begin(busy())
    const w = watch(handle)
    await handle.send('go')
    // turn/start is on the wire but unanswered for 300 ms: no turn id exists yet.
    const outcome = await handle.interrupt()
    expect(outcome).toBe('acked')

    const lines = readLog(log)
    const at = (pred: (r: Record<string, unknown>) => boolean): number => lines.findIndex(pred)
    const answered = at((r) => {
      const send = r['send'] as { result?: { turn?: unknown } } | undefined
      return send?.result?.turn !== undefined
    })
    const interrupted = at(
      (r) => (r['recv'] as { method?: string } | undefined)?.method === 'turn/interrupt'
    )
    expect(answered).toBeGreaterThan(-1)
    expect(interrupted).toBeGreaterThan(answered)
    const request = received(lines).find((m) => m.method === 'turn/interrupt')
    expect(request?.params).toMatchObject({ turnId: 'fake-turn-1' })

    // The turn ended as interrupted, and the thread still takes the next message.
    const result = w.turnResults()[0]
    expect(result).toMatchObject({
      ok: false,
      interrupted: true,
      status: 'interrupted',
      turnId: 'fake-turn-1'
    })
    await handle.send('again')
    await nthTurnResult(w, 2)
    expect(
      w.events.filter(isType('assistant-message')).map((e) => (e as { text: string }).text)
    ).toEqual(['working', 'after'])
  })

  it('is idle when no turn runs', async () => {
    const { handle } = await begin(busy())
    expect(await handle.interrupt()).toBe('idle')
  })

  it('interrupts a turn that is already running', async () => {
    const { handle } = await begin(busy())
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor(isType('assistant-message'), 'the turn to be busy')
    expect(await handle.interrupt()).toBe('acked')
  })

  it('hands back what was queued behind the running turn, and starts none of it after an interrupt', async () => {
    const { handle, log } = await begin(busy())
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor(isType('assistant-message'), 'the turn to be busy')
    await handle.send('[Arc] Message from the brain: use v2')
    await handle.send('[Arc] You have not called report_done.')

    expect(handle.discardQueuedSends?.()).toEqual([
      '[Arc] Message from the brain: use v2',
      '[Arc] You have not called report_done.'
    ])
    expect(handle.discardQueuedSends?.()).toEqual([])
    expect(await handle.interrupt()).toBe('acked')
    await new Promise((r) => setTimeout(r, 250))

    // Only the first send ever became a turn: the interrupted turn did not drain a queue.
    expect(received(readLog(log)).filter((m) => m.method === 'turn/start')).toHaveLength(1)
    expect(w.turnResults()).toHaveLength(1)
    // The thread still takes the user's next line.
    await handle.send('user line')
    await nthTurnResult(w, 2)
  })

  it('without discarding, an interrupted turn starts the next queued send (what step-in must prevent)', async () => {
    const { handle, log } = await begin(busy())
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor(isType('assistant-message'), 'the turn to be busy')
    await handle.send('[Arc] Message from the brain: use v2')
    expect(await handle.interrupt()).toBe('acked')
    await nthTurnResult(w, 2)
    const starts = received(readLog(log)).filter((m) => m.method === 'turn/start')
    expect(starts).toHaveLength(2)
    expect(JSON.stringify(starts[1]?.params)).toContain('use v2')
  })

  it('escalates to SIGINT, then reports killed, when Codex ignores the interrupt', async () => {
    const script = scenario([
      { ignoreInterrupt: true },
      { expect: 'turn/start' },
      { turnStarted: true },
      { say: 'stuck' },
      { sleep: 60_000 }
    ])
    const { handle } = await begin(script)
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor(isType('assistant-message'))
    expect(await handle.interrupt()).toBe('killed')
    const exit = await w.waitFor(isType('exit'))
    // we sent the signal, so the exit is expected and not a crash
    expect(exit).toMatchObject({ expected: true, signal: 'SIGINT' })
  })

  it('cancels the approval a turn is waiting on when the turn is interrupted', async () => {
    const seen: { aborted: boolean; reason?: unknown; request: CodexApprovalRequest }[] = []
    const approvals: ApprovalHandler = {
      handle: (request, signal) =>
        new Promise((resolve) => {
          const entry: (typeof seen)[number] = { aborted: false, request }
          seen.push(entry)
          signal.addEventListener('abort', () => {
            entry.aborted = true
            entry.reason = signal.reason
            resolve({ decision: 'accept' }) // a late answer must not reach Codex
          })
        })
    }
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { shell: 'git push', run: 'true', approval: true, saveAs: 'push' },
      { say: 'not reached' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script, { approvals })
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor((e) => e.type === 'approval' && e.state === 'requested', 'approval')
    expect(await handle.interrupt()).toBe('acked')
    await w.waitFor((e) => e.type === 'approval' && e.state === 'resolved', 'approval resolved')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
    // Codex withdrew it: the coordinator cancels the stored request for good
    expect(seen[0]?.reason).toBe(APPROVAL_WITHDRAWN)
    expect(w.events.find((e) => e.type === 'approval' && e.state === 'resolved')).toMatchObject({
      decision: 'cancelled'
    })
    await new Promise((r) => setTimeout(r, 100))
    // nothing was answered: the client sent no response line for the dead request
    expect(
      received(readLog(log)).filter((m) => m.method === undefined && m.id !== undefined)
    ).toEqual([])
  })
})

describe('CodexAdapter stop and crash', () => {
  it('stops cleanly when closing stdin ends the process', async () => {
    const { handle } = await begin(undefined)
    const w = watch(handle)
    await handle.stop()
    expect(await w.waitFor(isType('exit'))).toMatchObject({ code: 0, expected: true })
  })

  it('interrupts a running turn, then closes stdin, before it signals anything', async () => {
    const script = scenario([{ expect: 'turn/start' }, { turnStarted: true }, { sleep: 60_000 }])
    const { handle, log } = await begin(script)
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor(isType('turn-started'))
    await handle.stop()
    const exit = await w.waitFor(isType('exit'))
    expect(exit).toMatchObject({ code: 0, signal: null, expected: true })
    expect(received(readLog(log)).some((m) => m.method === 'turn/interrupt')).toBe(true)
  })

  it('sends SIGTERM when closing stdin does not end the process', async () => {
    const { handle } = await begin(scenario([{ ignoreStdinClose: true }]))
    const w = watch(handle)
    await new Promise((r) => setTimeout(r, 100))
    await handle.stop()
    expect(await w.waitFor(isType('exit'))).toMatchObject({ signal: 'SIGTERM', expected: true })
  })

  it('sends SIGKILL last, when the process ignores the signals as well', async () => {
    const { handle } = await begin(scenario([{ ignoreStdinClose: true }, { ignoreSignals: true }]))
    const w = watch(handle)
    await new Promise((r) => setTimeout(r, 100))
    const started = Date.now()
    await handle.stop()
    expect(await w.waitFor(isType('exit'))).toMatchObject({ signal: 'SIGKILL', expected: true })
    // it waited out the stdin grace period and the SIGTERM wait first
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      (fastTimings.stopGraceMs ?? 0) + (fastTimings.stopTermMs ?? 0) - 50
    )
  })

  it('reports a non-zero exit as a crash', async () => {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { stderr: 'boom\n' },
      { exit: 3 }
    ])
    const { handle } = await begin(script)
    const w = watch(handle)
    await handle.send('go')
    const exit = await w.waitFor(isType('exit'))
    expect(exit).toMatchObject({ code: 3, expected: false })
    expect((exit as { stderrTail: string }).stderrTail).toContain('boom')
  })
})

describe('CodexAdapter approvals', () => {
  /** Plays one command approval (the committed scenario) and returns what the handler saw and the model said. */
  async function playCommand(
    approvals: ApprovalHandler | undefined
  ): Promise<{ say: string; seen: CodexApprovalRequest[]; answer: unknown; ran: boolean }> {
    const seen: CodexApprovalRequest[] = []
    const wrapped: ApprovalHandler | undefined = approvals
      ? {
          handle: (request, signal) => {
            seen.push(request)
            return approvals.handle(request, signal)
          }
        }
      : undefined
    const bridge = await startStubBridge()
    bridges.push(bridge)
    const { handle, log } = await begin(
      undefined,
      {
        ...(wrapped ? { approvals: wrapped } : {}),
        bridge: { url: bridge.url, token: bridge.token },
        bridgeTools: ['report_done'],
        instructions: '[arc-role:worker]'
      },
      { FAKE_CODEX_SCRIPT_DIR: join(scenarios, 'command-approval') }
    )
    const w = watch(handle)
    await handle.send('push it')
    await nthTurnResult(w, 1)
    const lines = readLog(log)
    const answer = received(lines).find((m) => m.method === undefined && m.id !== undefined)?.result
    const messages = w.events.filter(isType('assistant-message')) as { text: string }[]
    return {
      say: messages.map((m) => m.text).join('|'),
      seen,
      answer,
      ran: lines.some((r) => (r['shell'] as { cmd?: string } | undefined)?.cmd !== undefined)
    }
  }

  it('hands a command approval to the handler with the raw params and the item, and runs on accept', async () => {
    const played = await playCommand({ handle: () => Promise.resolve({ decision: 'accept' }) })
    expect(played.seen).toHaveLength(1)
    const request = played.seen[0]
    expect(request).toMatchObject({
      kind: 'command',
      method: 'item/commandExecution/requestApproval',
      agentId: 'w1',
      item: { type: 'commandExecution', id: 'push-1' }
    })
    expect(request?.raw['command']).toBe("/bin/zsh -lc 'git push origin HEAD'")
    expect(played.answer).toEqual({ decision: 'accept' })
    expect(played.say).toContain('The push was accept.')
    expect(played.ran).toBe(true)
  })

  it.each([
    ['decline', { decision: 'decline' as const }, 'decline'],
    ['cancel', { decision: 'cancel' as const }, 'cancel']
  ])('answers %s with exactly that', async (_n, decision, wire) => {
    const played = await playCommand({ handle: () => Promise.resolve(decision) })
    expect(played.answer).toEqual({ decision: wire })
    expect(played.ran).toBe(false)
  })

  it('declines when no handler is given, when the handler throws, and for a decision it does not know', async () => {
    expect((await playCommand(undefined)).answer).toEqual({ decision: 'decline' })
    expect((await playCommand({ handle: () => Promise.reject(new Error('boom')) })).answer).toEqual(
      {
        decision: 'decline'
      }
    )
    // never a session-wide grant, even if a handler asks for one
    const bad = {
      handle: () => Promise.resolve({ decision: 'acceptForSession' })
    } as unknown as ApprovalHandler
    expect((await playCommand(bad)).answer).toEqual({ decision: 'decline' })
  })

  /** Plays an approval that waits for the model (the interrupt scenario) and returns the lines the client sent, in order. */
  async function playDecline(decision: CodexApprovalDecision): Promise<string[]> {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { shell: 'git push', run: 'true', approval: true, saveAs: 'push' },
      { say: 'went on' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script, {
      approvals: { handle: () => Promise.resolve(decision) }
    })
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)
    return received(readLog(log)).flatMap((m) =>
      m.method === 'turn/steer'
        ? ['steer:' + JSON.stringify((m.params?.['input'] as { text: string }[])[0]?.text)]
        : m.method === undefined && m.id !== undefined
          ? ['answer:' + JSON.stringify(m.result)]
          : []
    )
  }

  it('steers the denial message into the turn FIRST, then declines (spike S6)', async () => {
    const lines = await playDecline({
      decision: 'decline',
      message: 'Do not push; tell me instead.'
    })
    expect(lines).toEqual([
      'steer:"[Arc] Do not push; tell me instead."',
      'answer:{"decision":"decline"}'
    ])
  })

  it('declines without a steer when the denial has no message, and never steers a cancel or an accept', async () => {
    expect(await playDecline({ decision: 'decline' })).toEqual(['answer:{"decision":"decline"}'])
    expect(await playDecline({ decision: 'cancel', message: 'stop' })).toEqual([
      'answer:{"decision":"cancel"}'
    ])
    expect(await playDecline({ decision: 'accept', message: 'ignored' })).toEqual([
      'answer:{"decision":"accept"}'
    ])
  })

  it('answers file changes, permissions, MCP elicitations and questions in the shapes Codex expects', async () => {
    const kinds: string[] = []
    const approvals: ApprovalHandler = {
      handle: (request) => {
        kinds.push(request.kind)
        return Promise.resolve({ decision: 'accept' })
      }
    }
    const profile = { fileSystem: { write: ['/outside'] }, network: { enabled: true } }
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { write: { path: 'a.txt', content: 'x\n' }, id: 'p1', approval: true, saveAs: 'file' },
      {
        request: {
          method: 'item/permissions/requestApproval',
          params: { itemId: 'perm', reason: 'needs the network', cwd: '/w', permissions: profile }
        },
        saveAs: 'perm'
      },
      {
        request: {
          method: 'mcpServer/elicitation/request',
          params: {
            serverName: 'figma',
            mode: 'form',
            message: 'Allow the figma MCP server to run tool "get"?',
            requestedSchema: { type: 'object', properties: {} },
            _meta: { codex_approval_kind: 'mcp_tool_call' }
          }
        },
        saveAs: 'mcp'
      },
      {
        request: {
          method: 'mcpServer/elicitation/request',
          params: { serverName: 'figma', mode: 'url', message: 'Sign in', _meta: null }
        },
        saveAs: 'other'
      },
      {
        request: {
          method: 'item/tool/requestUserInput',
          params: { itemId: 'q', questions: [{ question: 'Which one?', header: 'Pick' }] }
        },
        saveAs: 'question'
      },
      { request: { method: 'item/tool/call', params: {} }, saveAs: 'unknown' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script, { approvals, cwd: dir })
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)
    const answers = received(readLog(log))
      .filter((m) => m.method === undefined && m.id !== undefined)
      .map((m) => m as { id: number; result?: unknown; error?: { code: number } })
    expect(answers.map((a) => a.result ?? a.error)).toEqual([
      { decision: 'accept' }, // file change
      { permissions: profile, scope: 'turn' },
      { action: 'accept', content: null }, // the tool approval
      { action: 'cancel', content: null }, // a form that is not a tool approval
      { answers: {} },
      expect.objectContaining({ code: -32601 })
    ])
    // the handler heard about the first three only
    expect(kinds).toEqual(['file-change', 'permissions', 'mcp-elicitation'])
    expect(w.events.find(isType('user-input-request'))).toMatchObject({
      questions: [{ question: 'Which one?', header: 'Pick' }]
    })
    // the form that was not an approval shows up as an unknown event, not silence
    expect(
      w.events.some(
        (e) => e.type === 'unknown' && JSON.stringify(e.raw).includes('not a tool approval')
      )
    ).toBe(true)
  })

  it('answers requestUserInput with no answers and never shows it to the approval handler (S5)', async () => {
    const seen: string[] = []
    const approvals: ApprovalHandler = {
      handle: (request) => {
        seen.push(request.kind)
        return Promise.resolve({ decision: 'accept' })
      }
    }
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      {
        request: {
          method: 'item/tool/requestUserInput',
          params: { itemId: 'q', questions: [{ question: 'Which one?', header: 'Pick' }] }
        },
        saveAs: 'question'
      },
      { say: 'carrying on' },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script, { approvals })
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)

    const answers = received(readLog(log)).filter(
      (m) => m.method === undefined && m.id !== undefined
    )
    expect(answers.map((a) => a.result)).toEqual([{ answers: {} }])
    expect(seen).toEqual([])
    // The turn went on; the worker's only question path is ask_brain.
    expect(w.events.find(isType('assistant-message'))).toMatchObject({ text: 'carrying on' })
    expect(w.turnResults()[0]).toMatchObject({ ok: true })
  })

  it('refuses extra permissions with an empty profile for this turn, never for the session', async () => {
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      {
        request: {
          method: 'item/permissions/requestApproval',
          params: { itemId: 'perm', permissions: { network: { enabled: true } } }
        },
        saveAs: 'perm'
      },
      { turnCompleted: 'completed' }
    ])
    const { handle, log } = await begin(script, {
      approvals: { handle: () => Promise.resolve({ decision: 'decline' }) }
    })
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)
    const answer = received(readLog(log)).find((m) => m.method === undefined && m.id !== undefined)
    expect(answer?.result).toEqual({ permissions: {}, scope: 'turn' })
  })

  it('finds the MCP call an elicitation belongs to and passes its read-only hint along', async () => {
    const seen: CodexApprovalRequest[] = []
    const bridge = await startStubBridge()
    bridges.push(bridge)
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { mcp: { tool: 'report_progress', args: { note: 'hi' } }, id: 'mcp-1', approval: true },
      { turnCompleted: 'completed' }
    ])
    const { handle } = await begin(script, {
      bridge: { url: bridge.url, token: bridge.token },
      approvals: {
        handle: (request) => {
          seen.push(request)
          return Promise.resolve({ decision: 'accept' })
        }
      }
    })
    const w = watch(handle)
    await handle.send('go')
    await nthTurnResult(w, 1)
    expect(seen[0]?.item).toMatchObject({
      type: 'mcpToolCall',
      server: 'arc',
      tool: 'report_progress'
    })
    expect(bridge.calls.map((c) => c.tool)).toEqual(['report_progress'])
  })
})

describe('CodexAdapter against the committed scenarios', () => {
  it('worker-commit: edits and commits in a linked worktree, and reports done through the bridge', async () => {
    const repo = join(dir, 'repo')
    const tree = join(dir, 'tree')
    mkdirSync(repo)
    const git = (cwd: string, ...args: string[]): void => {
      execFileSync('git', args, { cwd, stdio: 'ignore' })
    }
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'hello.txt'), 'hello\n')
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init')
    git(repo, 'worktree', 'add', '-q', '-b', 'w', tree)

    const bridge = await startStubBridge('real-token')
    bridges.push(bridge)
    const approved: string[] = []
    const { handle, log } = await begin(
      undefined,
      {
        cwd: tree,
        bridge: { url: bridge.url, token: bridge.token },
        bridgeTools: ['report_progress', 'report_done'],
        instructions: '[arc-role:worker] [arc-worker:edit-hello]',
        approvals: {
          handle: (request) => {
            approved.push(request.kind)
            return Promise.resolve({ decision: 'accept' })
          }
        }
      },
      { FAKE_CODEX_SCRIPT_DIR: join(scenarios, 'worker-commit') }
    )
    const w = watch(handle)
    await handle.send('Patch hello.txt')
    await nthTurnResult(w, 1)

    expect(readFileSync(join(tree, 'hello.txt'), 'utf8')).toBe('hello\npatched\n')
    expect(
      execFileSync('git', ['log', '-1', '--format=%s'], { cwd: tree, encoding: 'utf8' }).trim()
    ).toBe('Patch hello')
    expect(approved).toEqual(['file-change', 'command'])
    // real MCP calls, with the bearer token the adapter put in the env var
    expect(bridge.calls.map((c) => [c.tool, c.authorization])).toEqual([
      ['report_progress', 'Bearer real-token'],
      ['report_done', 'Bearer real-token']
    ])
    expect(bridge.calls[1]?.args).toEqual({ summary: 'Patched hello.txt and committed' })

    // the sandbox roots came from the worktree's .git file
    const thread = readLog(log).find((r) => r['thread'])?.['thread'] as {
      config: Record<string, unknown>
    }
    const sandbox = thread.config['sandbox_workspace_write'] as { writable_roots: string[] }
    expect(sandbox.writable_roots).toEqual([
      tree,
      join(repo, '.git', 'worktrees', 'tree'),
      join(repo, '.git', 'objects'),
      join(repo, '.git', 'refs'),
      join(repo, '.git', 'logs')
    ])
    const tools = w.events.filter(isType('tool-use')).map((e) => (e as { name: string }).name)
    expect(tools).toEqual(['mcp:arc.report_progress', 'Edit', 'Bash', 'mcp:arc.report_done'])
    expect(
      w.events.filter(isType('tool-result')).every((e) => !(e as { isError: boolean }).isError)
    ).toBe(true)
  })

  it('interrupt: an interrupted worker takes the next message', async () => {
    const { handle } = await begin(
      undefined,
      { instructions: '[arc-role:worker]' },
      {
        FAKE_CODEX_SCRIPT_DIR: join(scenarios, 'interrupt')
      }
    )
    const w = watch(handle)
    await handle.send('work')
    await w.waitFor((e) => e.type === 'assistant-message', 'the worker to be busy')
    expect(await handle.interrupt()).toBe('acked')
    await handle.send('carry on')
    await nthTurnResult(w, 2)
    expect(
      w.events.filter(isType('assistant-message')).map((e) => (e as { text: string }).text)
    ).toEqual(['Working on it.', 'Back after the interrupt.'])
    expect(w.turnResults().map((e) => (e as { status: string }).status)).toEqual([
      'interrupted',
      'completed'
    ])
  })

  it('command-approval: a declined push is declined and nothing runs', async () => {
    const bridge = await startStubBridge()
    bridges.push(bridge)
    const { handle } = await begin(
      undefined,
      {
        bridge: { url: bridge.url, token: bridge.token },
        instructions: '[arc-role:worker]',
        approvals: { handle: () => Promise.resolve({ decision: 'decline' }) }
      },
      { FAKE_CODEX_SCRIPT_DIR: join(scenarios, 'command-approval') }
    )
    const w = watch(handle)
    await handle.send('push')
    await nthTurnResult(w, 1)
    const said = w.events
      .filter(isType('assistant-message'))
      .map((e) => (e as { text: string }).text)
    expect(said).toContain('The push was decline.')
    expect(bridge.calls[0]?.args).toEqual({ summary: 'Push decline' })
  })
})

describe('CodexAdapter approvals when the process ends', () => {
  it('aborts a waiting handler without the withdrawn reason, so the request stays pending for the resume', async () => {
    let reason: unknown = 'unset'
    let aborted = false
    const approvals: ApprovalHandler = {
      handle: (_request, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reason = signal.reason
            resolve({ decision: 'decline' })
          })
        })
    }
    const script = scenario([
      { expect: 'turn/start' },
      { turnStarted: true },
      { shell: 'git push', run: 'true', approval: true, saveAs: 'push' },
      { turnCompleted: 'completed' }
    ])
    const { handle } = await begin(script, { approvals })
    const w = watch(handle)
    await handle.send('go')
    await w.waitFor((e) => e.type === 'approval' && e.state === 'requested', 'approval')
    await handle.stop()
    await w.waitFor(isType('exit'))
    expect(aborted).toBe(true)
    expect(reason).not.toBe(APPROVAL_WITHDRAWN)
  })
})

describe('CodexAdapter working copies', () => {
  function adapterWith(prepareWorkingCopy?: (path: string) => void): CodexAdapter {
    return new CodexAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: fastTimings,
      clientVersion: '9.9.9',
      ...(prepareWorkingCopy ? { prepareWorkingCopy } : {})
    })
  }

  it('prepares every working copy of a worker, and not the read-only folders, before each start', async () => {
    const prepared: string[] = []
    const second = join(dir, 'second-tree')
    const readOnly = join(dir, 'knowledge')
    for (const d of [second, readOnly]) mkdirSync(d, { recursive: true })
    for (const resume of [false, true]) {
      const { handle } = await begin(
        undefined,
        {
          addDirs: [second, readOnly],
          readOnlyDirs: [readOnly],
          ...(resume ? { resume: { threadId: 'thread-1' } } : {})
        },
        {},
        adapterWith((p) => prepared.push(p))
      )
      await handle.stop()
    }
    // launch and relaunch both prepare
    expect(prepared).toEqual([dir, second, dir, second])
  })

  it('does not touch the brain working directory', async () => {
    const prepared: string[] = []
    const { handle } = await begin(
      undefined,
      { role: 'brain', access: 'brain-readonly' },
      {},
      adapterWith((p) => prepared.push(p))
    )
    await handle.stop()
    expect(prepared).toEqual([])
  })

  it('does not start a worker when its rules cannot be written', async () => {
    const log = logPath()
    await expect(
      adapterWith(() => {
        throw new Error('disk full')
      }).start(options({ extraEnv: { FAKE_CODEX_LOG: log } }))
    ).rejects.toThrow('disk full')
    // no app-server was spawned
    expect(readLog(log)).toEqual([])
  })

  it('writes Arc rules into the worker working copy by default', async () => {
    const tree = join(dir, 'default-rules-tree')
    mkdirSync(tree, { recursive: true })
    const { handle } = await begin(undefined, { cwd: tree })
    await handle.stop()
    expect(readFileSync(join(tree, '.codex', 'rules', 'arc.rules'), 'utf8')).toContain(
      'prefix_rule(pattern=["git","push"], decision="prompt")'
    )
  })
})
