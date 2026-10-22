import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '../../../src/main/agents/agent-adapter'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { ClaudeAdapter, type ClaudeAdapterTimings } from '../../../src/main/agents/claude-adapter'
import { ProcessSupervisor } from '../../../src/main/agents/process-supervisor'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const stub = resolve('tests/unit/agents/helpers/stub-child.mjs')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }

let dir: string
const handles: AgentHandle[] = []
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'arc-adapter-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
})

const fastTimings: Partial<ClaudeAdapterTimings> = {
  interruptAckMs: 150,
  sigintMs: 150,
  termMs: 150,
  stopGraceMs: 1000,
  stopTermMs: 300
}

function adapterFor(script: string, binaryArgs: string[] = []): ClaudeAdapter {
  return new ClaudeAdapter({
    supervisor: new ProcessSupervisor(),
    binary: process.execPath,
    binaryArgs: [script, ...binaryArgs],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    timings: fastTimings
  })
}

async function begin(
  adapter: ClaudeAdapter,
  extraEnv: Record<string, string> = {}
): Promise<AgentHandle> {
  const handle = await adapter.start({
    provider: 'claude',
    agentId: 'brain',
    role: 'brain',
    cwd: process.cwd(),
    model: 'haiku',
    access: 'brain-readonly',
    claude: {},
    extraEnv: { ...nodeEnv, ...extraEnv }
  })
  handles.push(handle)
  return handle
}

/** Collects events in the background and lets a test wait for one. */
function watch(handle: AgentHandle): {
  events: AgentEvent[]
  waitFor: (type: AgentEvent['type']) => Promise<AgentEvent>
  done: Promise<void>
} {
  const events: AgentEvent[] = []
  const done = (async () => {
    for await (const e of handle.events) events.push(e)
  })()
  const waitFor = async (type: AgentEvent['type']): Promise<AgentEvent> => {
    const deadline = Date.now() + 5000
    for (;;) {
      const hit = events.find((e) => e.type === type)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`)
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  return { events, waitFor, done }
}

function scenario(name: string, steps: unknown[]): string {
  const p = join(dir, name)
  writeFileSync(p, steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  return p
}

const initEvent = {
  type: 'system',
  subtype: 'init',
  session_id: '{{SESSION_ID}}',
  model: 'fake',
  permissionMode: 'default',
  mcp_servers: []
}

describe('ClaudeAdapter with fake-claude', () => {
  it('passes the built argv, sends a stream-json user line, and streams a turn', async () => {
    const log = join(dir, 'argv.log')
    const script = scenario('text.jsonl', [
      { emit: initEvent },
      { waitForStdin: 'hello' },
      {
        emit: {
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'm1' } }
        }
      },
      {
        emit: {
          type: 'stream_event',
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }
        }
      },
      {
        emit: {
          type: 'assistant',
          message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] }
        }
      },
      { emit: { type: 'result', subtype: 'success', is_error: false, duration_ms: 3 } }
    ])
    const handle = await begin(adapterFor(fake), {
      FAKE_CLAUDE_SCRIPT: script,
      FAKE_CLAUDE_LOG: log
    })
    const w = watch(handle)
    await w.waitFor('session')
    expect(await handle.send('hello')).toBe(true)
    await w.waitFor('turn-result')
    expect(w.events.map((e) => e.type)).toEqual([
      'session',
      'text-delta',
      'usage-progress',
      'assistant-message',
      'usage',
      'turn-result'
    ])
    await handle.stop()
    await w.done
    const exit = w.events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', code: 0, expected: true })

    const records = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { argv?: string[]; stdin?: unknown })
    expect(records[0]?.argv).toContain('--include-partial-messages')
    expect(records[0]?.argv).toContain('--disallowedTools')
    expect(records.find((r) => r.stdin !== undefined)?.stdin).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] }
    })
  })

  it('marks every agent with ARC_AGENT, ARC_AGENT_ROLE and ARC_PROVIDER, and passes the hooks-only --settings file', async () => {
    const log = join(dir, 'markers.log')
    const hooks = join(dir, 'hooks.settings.json')
    writeFileSync(hooks, JSON.stringify({ hooks: { SessionStart: [] } }))
    const script = scenario('markers.jsonl', [{ emit: initEvent }, { result: true }])
    const handle = await adapterFor(fake).start({
      provider: 'claude',
      agentId: 'w1',
      role: 'worker',
      cwd: process.cwd(),
      model: 'haiku',
      access: 'worker-write',
      claude: { hooksSettingsPath: hooks },
      // Whatever the caller puts in extraEnv, the markers say who the agent is.
      extraEnv: {
        ...nodeEnv,
        FAKE_CLAUDE_SCRIPT: script,
        FAKE_CLAUDE_LOG: log,
        ARC_AGENT_ROLE: 'brain'
      }
    })
    handles.push(handle)
    const w = watch(handle)
    await w.waitFor('session')
    await handle.stop()
    await w.done
    const records = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(records.find((r) => 'arcEnv' in r)?.['arcEnv']).toEqual({
      ARC_AGENT: '1',
      ARC_AGENT_ROLE: 'worker',
      ARC_PROVIDER: 'claude'
    })
    const argv = records[0]?.['argv'] as string[]
    expect(argv[argv.indexOf('--settings') + 1]).toBe(hooks)
    expect(argv.some((r) => r === '--setting-sources')).toBe(true)
    // The fake's argv assertion passed: it would have exited with code 2 otherwise.
    expect(records.some((r) => 'argvViolation' in r)).toBe(false)
  })

  it('interrupt is acked by the CLI: turn ends interrupted, process stays up, next turn works', async () => {
    const script = scenario('hang.jsonl', [
      { emit: initEvent },
      { waitForStdin: 'count' },
      { hang: true }
    ])
    const handle = await begin(adapterFor(fake), { FAKE_CLAUDE_SCRIPT: script })
    const w = watch(handle)
    await w.waitFor('session')
    await handle.send('count to 200')
    expect(await handle.interrupt()).toBe('acked')
    const types = w.events.map((e) => e.type)
    expect(types).toContain('control-ack')
    expect(w.events.find((e) => e.type === 'turn-result')).toMatchObject({
      ok: false,
      interrupted: true
    })
    expect(w.events.some((e) => e.type === 'exit')).toBe(false)
    expect(await handle.interrupt()).toBe('idle')
    await handle.stop()
    await w.done
    // We stopped it: not a crash.
    expect(w.events.at(-1)).toMatchObject({ type: 'exit', expected: true })
  })
})

describe('interrupt ladder', () => {
  it('escalates to SIGINT when the CLI ignores the interrupt request', async () => {
    const handle = await begin(adapterFor(stub, ['sigint-dies']))
    const w = watch(handle)
    await w.waitFor('unknown') // the stub's ready line
    await handle.send('go')
    expect(await handle.interrupt()).toBe('killed') // SIGINT ends the stub, so no turn-result arrives
    await w.done
    expect(w.events.at(-1)).toMatchObject({ type: 'exit', signal: 'SIGINT', expected: true })
  })

  it('escalates through SIGTERM to SIGKILL when SIGINT and SIGTERM are ignored', async () => {
    const handle = await begin(adapterFor(stub, ['ignore-all']))
    const w = watch(handle)
    await w.waitFor('unknown')
    await handle.send('go')
    const started = Date.now()
    expect(await handle.interrupt()).toBe('killed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(150 + 150 + 150)
    await w.done
    expect(w.events.at(-1)).toMatchObject({ type: 'exit', signal: 'SIGKILL', expected: true })
  })

  it('stop() on a stubborn process ends with SIGKILL after the grace periods', async () => {
    const handle = await begin(adapterFor(stub, ['ignore-all']))
    const w = watch(handle)
    await w.waitFor('unknown')
    await handle.stop()
    await w.done
    expect(w.events.at(-1)).toMatchObject({ type: 'exit', signal: 'SIGKILL', expected: true })
  })
})

describe('adapter exits', () => {
  it('a crash exit is reported as unexpected with the stderr tail', async () => {
    const handle = await begin(adapterFor(stub, ['exit1']))
    const w = watch(handle)
    await w.done
    const exit = w.events.at(-1)
    expect(exit).toMatchObject({ type: 'exit', code: 1, expected: false })
    expect(exit && 'stderrTail' in exit ? exit.stderrTail : '').toContain('boom from stub')
  })

  it('a missing binary yields a not-installed error then exit', async () => {
    const adapter = new ClaudeAdapter({
      supervisor: new ProcessSupervisor(),
      binary: '/definitely/not/claude',
      resolvePath: () => Promise.resolve(''),
      timings: fastTimings
    })
    const handle = await begin(adapter)
    const w = watch(handle)
    await w.done
    expect(w.events.map((e) => e.type)).toEqual(['error', 'exit'])
    expect(w.events[0]).toMatchObject({ kind: 'not-installed' })
    expect(w.events[1]).toMatchObject({ expected: false })
  })
})
