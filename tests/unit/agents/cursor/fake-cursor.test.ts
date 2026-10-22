import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ProviderHistoryMissingError,
  ProviderUnavailableError,
  type AgentHandle,
  type CursorStartRequest
} from '../../../../src/main/agents/agent-adapter'
import type { AgentEvent } from '../../../../src/main/agents/agent-events'
import type { CursorApprovalHandler } from '../../../../src/main/agents/cursor/cursor-types'
import { CursorAdapter } from '../../../../src/main/agents/cursor/cursor-adapter'
import { ProcessSupervisor } from '../../../../src/main/agents/process-supervisor'
import { until } from './fake-acp'

/**
 * The fake Cursor (tests/e2e/fixtures/fake-cursor.mjs, `acp` mode) against the real CursorAdapter and AcpClient:
 * a real child process, no Electron. Proves the fake speaks what the adapter sends and expects.
 */

const FAKE = resolve('tests/e2e/fixtures/fake-cursor.mjs')
const dirs: string[] = []
const handles: AgentHandle[] = []
const servers: Server[] = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  for (const s of servers.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Setup {
  dir: string
  log: string
  /** Writes scripts/<name>.jsonl and returns the script directory. */
  scripts(files: Record<string, string[]>): string
}

function setup(): Setup {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cursor-test-'))
  dirs.push(dir)
  return {
    dir,
    log: join(dir, 'log.jsonl'),
    scripts(files) {
      const out = join(dir, 'scripts')
      mkdirSync(out, { recursive: true })
      for (const [name, lines] of Object.entries(files)) {
        writeFileSync(join(out, `${name}.jsonl`), lines.join('\n') + '\n')
      }
      return out
    }
  }
}

const STEPS = (...steps: object[]): string[] => steps.map((s) => JSON.stringify(s))

function adapter(env: Record<string, string>): CursorAdapter {
  return new CursorAdapter({
    supervisor: new ProcessSupervisor(),
    binary: () => process.execPath,
    binaryArgs: [FAKE],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    env: { PATH: process.env['PATH'] ?? '', HARNESS_E2E: '1', ...env },
    timings: { interruptAckMs: 2000, requestMs: 10_000 }
  })
}

function request(cwd: string, over: Partial<CursorStartRequest> = {}): CursorStartRequest {
  return {
    provider: 'cursor',
    agentId: 'w1',
    role: 'worker',
    cwd,
    model: 'default[]',
    access: 'worker-write',
    cursor: {},
    instructions: '[arc-role:worker]\n[arc-worker:demo]',
    ...over
  }
}

async function begin(
  env: Record<string, string>,
  cwd: string,
  over: Partial<CursorStartRequest> = {}
): Promise<{ handle: AgentHandle; events: AgentEvent[] }> {
  const handle = await adapter(env).start(request(cwd, over))
  handles.push(handle)
  const events: AgentEvent[] = []
  void (async () => {
    for await (const e of handle.events) events.push(e)
  })()
  return { handle, events }
}

const logOf = (path: string): Record<string, unknown>[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)

describe('fake-cursor acp against the real adapter', () => {
  it('handshakes, runs a scripted turn with text and a permission request that is rejected by default, and ends', async () => {
    const s = setup()
    const scripts = s.scripts({
      worker: STEPS(
        { expect: 'prompt' },
        { text: 'Hello from the fake.' },
        { shell: 'echo hi', approval: true, id: 'sh-1', saveAs: 'asked' },
        { text: 'Finished.' },
        { end: 'end_turn' }
      )
    })
    const { handle, events } = await begin(
      { FAKE_CURSOR_LOG: s.log, FAKE_CURSOR_SCRIPT_DIR: scripts, FAKE_CURSOR_SESSION_ID: 'sess-9' },
      s.dir
    )
    await handle.send('please work')
    await until(() => events.some((e) => e.type === 'turn-result'), 10_000)

    expect(events.find((e) => e.type === 'session')).toMatchObject({
      providerSessionId: 'sess-9',
      model: 'default[]'
    })
    const messages = events.filter((e) => e.type === 'assistant-message')
    expect(messages.map((m) => (m as { text: string }).text).join('|')).toContain(
      'Hello from the fake.'
    )
    expect(events.filter((e) => e.type === 'approval')).toMatchObject([
      { state: 'requested' },
      { state: 'resolved', decision: 'deny' }
    ])
    expect(events.find((e) => e.type === 'turn-result')).toMatchObject({
      ok: true,
      status: 'completed'
    })

    const log = logOf(s.log)
    const methods = log.flatMap((l) => {
      const m = (l['recv'] as { method?: string } | undefined)?.method
      return m ? [m] : []
    })
    expect(methods).toEqual([
      'initialize',
      'authenticate',
      'session/new',
      'session/set_model',
      'session/prompt'
    ])
    // The rejected command did not run, and the answer was by option kind.
    expect(log.some((l) => 'shell' in l)).toBe(false)
    expect(log.find((l) => 'permission' in l)).toMatchObject({
      permission: { outcome: 'selected', optionId: 'reject-once' }
    })
    expect(log.find((l) => 'agent' in l)).toMatchObject({
      agent: { role: 'worker', slug: 'demo', resumed: false }
    })
    expect(readFileSync(s.log, 'utf8')).toContain('<arc-instructions>')
  })

  it('cancels a running turn: the pending request is answered cancelled and the prompt ends cancelled', async () => {
    const s = setup()
    const scripts = s.scripts({
      worker: STEPS(
        { expect: 'prompt' },
        { shell: 'echo hi', approval: true },
        { text: 'never' },
        { end: 'end_turn' }
      )
    })
    // Nobody decides: the request stays open until Arc withdraws it.
    const approvals: CursorApprovalHandler = {
      handle: (_request, signal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve({ decision: 'cancel' }))
        )
    }
    const { handle, events } = await begin(
      { FAKE_CURSOR_LOG: s.log, FAKE_CURSOR_SCRIPT_DIR: scripts },
      s.dir,
      { cursor: { approvals } }
    )
    await handle.send('go')
    await until(() => events.some((e) => e.type === 'approval'), 10_000)
    await expect(handle.interrupt()).resolves.toBe('acked')
    await until(() => events.some((e) => e.type === 'turn-result'), 10_000)
    expect(events.find((e) => e.type === 'turn-result')).toMatchObject({ interrupted: true })
    expect(events.some((e) => e.type === 'assistant-message')).toBe(false)
    const answers = logOf(s.log).flatMap((l) => {
      const r = l['recv'] as { method?: string; result?: unknown } | undefined
      return r && r.method === undefined && r.result ? [r.result] : []
    })
    expect(answers).toEqual([{ outcome: { outcome: 'cancelled' } }])
  })

  it('maps a signed-out login, a missing session and an unknown model to what the adapter expects', async () => {
    const s = setup()
    await expect(
      adapter({ FAKE_CURSOR_AUTH: 'signed_out' }).start(request(s.dir))
    ).rejects.toBeInstanceOf(ProviderUnavailableError)
    await expect(
      adapter({ FAKE_CURSOR_RESUME_FAIL: '1' }).start(
        request(s.dir, { resume: { threadId: 'gone' } })
      )
    ).rejects.toBeInstanceOf(ProviderHistoryMissingError)
    await expect(adapter({}).start(request(s.dir, { model: 'nope[]' }))).rejects.toThrow()
  })

  it('calls the bridge from session/new with its bearer header, follows a pending result with wait_for, and writes files', async () => {
    const s = setup()
    const seen: { auth: string | undefined; body: { method?: string; params?: unknown } }[] = []
    const bridge = createServer((req: IncomingMessage, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const msg = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string } }
        seen.push({ auth: req.headers.authorization, body: msg })
        if (msg.id === undefined) return void res.writeHead(202).end()
        const text =
          msg.params?.name === 'ask_brain'
            ? JSON.stringify({ status: 'pending', waitId: 'w_1' })
            : JSON.stringify({ answer: 'yes' })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: msg.method === 'tools/call' ? { content: [{ type: 'text', text }] } : {}
          })
        )
      })
    })
    servers.push(bridge)
    await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/mcp`
    const scripts = s.scripts({
      worker: STEPS(
        { expect: 'prompt' },
        { write: { path: 'sub/note.txt', content: 'hello\n' }, id: 'edit-1' },
        { mcp: { tool: 'ask_brain', args: { question: 'q' } }, follow: true },
        { end: 'end_turn' }
      )
    })
    const { handle, events } = await begin(
      { FAKE_CURSOR_LOG: s.log, FAKE_CURSOR_SCRIPT_DIR: scripts },
      s.dir,
      { bridge: { url, token: 'tok-1' } }
    )
    await handle.send('go')
    await until(() => events.some((e) => e.type === 'turn-result'), 10_000)

    expect(readFileSync(join(s.dir, 'sub/note.txt'), 'utf8')).toBe('hello\n')
    const calls = seen.filter((c) => c.body.method === 'tools/call')
    expect(calls.map((c) => (c.body.params as { name: string }).name)).toEqual([
      'ask_brain',
      'wait_for'
    ])
    expect(seen.every((c) => c.auth === 'Bearer tok-1')).toBe(true)
    expect(JSON.stringify(calls)).not.toContain('progressToken')
    const results = logOf(s.log).flatMap((l) => ('mcpResult' in l ? [l['mcpResult']] : []))
    expect(results).toMatchObject([
      { tool: 'ask_brain' },
      { tool: 'wait_for', text: '{"answer":"yes"}' }
    ])
  })
})
