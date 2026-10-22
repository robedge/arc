import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeServer } from '../../../src/main/bridge/bridge-server'
import { BridgeToolError } from '../../../src/main/bridge/types'
import type { BridgeAgent, BridgeServices } from '../../../src/main/bridge/types'
import { useTempDir } from '../helpers/temp-dir'
import { callTool, listTools, mcpRequest, rawPost, readMcpConfig } from '../helpers/mcp-client'

const dir = useTempDir('arc-bridge-')
let bridge: BridgeServer

const brain: BridgeAgent = { sessionId: 's1', agentId: 'brain-s1', role: 'brain' }
const worker: BridgeAgent = { sessionId: 's1', agentId: 'worker-w1', role: 'worker' }

function fakeServices(overrides: Partial<BridgeServices> = {}): BridgeServices {
  return {
    proposePlan: vi.fn(() =>
      Promise.resolve({
        planId: 'p1',
        decision: 'approved' as const,
        models: { a: 'sonnet' },
        providers: { a: 'claude' as const }
      })
    ),
    spawnWorker: vi.fn(() =>
      Promise.resolve({
        workerId: 'w1',
        status: 'started' as const,
        provider: 'claude' as const,
        model: 'sonnet',
        note: null
      })
    ),
    messageWorker: vi.fn(() => Promise.resolve({ delivered: true })),
    getWorkerStatus: vi.fn(() => []),
    mergeWorker: vi.fn(() =>
      Promise.resolve({ merged: true, result: 'clean' as const, files: ['api/a.txt'] })
    ),
    syncWorker: vi.fn(() => Promise.resolve({ synced: true, files: [], notified: true })),
    reportProgress: vi.fn(() => ({ ok: true as const })),
    reportDone: vi.fn(() => Promise.resolve({ ok: true as const })),
    requestPermission: vi.fn((_agent, input) =>
      Promise.resolve({ behavior: 'allow' as const, updatedInput: input.input })
    ),
    requestAction: vi.fn(() => Promise.resolve({ allow: true as const })),
    askBrain: vi.fn(() => Promise.resolve({ answer: 'yes' })),
    resolveRequest: vi.fn(() => ({ ok: true as const })),
    escalateToUser: vi.fn(() => ({ ok: true as const })),
    askUser: vi.fn(() => Promise.resolve({ answer: 'yes' })),
    ...overrides
  }
}

beforeEach(async () => {
  bridge = new BridgeServer({
    configDir: join(dir(), 'mcp'),
    log: { warn: vi.fn(), error: vi.fn() },
    progressIntervalMs: 30
  })
  await bridge.start()
})
afterEach(async () => {
  await bridge.close()
})

describe('bridge authentication', () => {
  it('rejects a request without a token', async () => {
    const reg = bridge.registerAgent(brain, fakeServices())
    const config = readMcpConfig(reg.configPath)
    const res = await rawPost(config.url, {}, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(401)
  })

  it('rejects a wrong token', async () => {
    const reg = bridge.registerAgent(brain, fakeServices())
    const config = readMcpConfig(reg.configPath)
    const res = await rawPost(
      config.url,
      { authorization: 'Bearer nope' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    )
    expect(res.status).toBe(401)
  })

  it('rejects a Host header that is not the loopback address', async () => {
    const reg = bridge.registerAgent(brain, fakeServices())
    const config = readMcpConfig(reg.configPath)
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
    const bad = await rawPost(config.url, { ...config.headers, host: 'evil.example.com' }, body)
    expect(bad.status).toBe(403)
    const rebinding = await rawPost(
      config.url,
      { ...config.headers, host: `evil.example.com:${bridge.port}` },
      body
    )
    expect(rebinding.status).toBe(403)
    const good = await rawPost(config.url, config.headers, body)
    expect(good.status).toBe(200)
  })

  it('answers only POST /mcp: GET is 405 and other paths are 404', async () => {
    const reg = bridge.registerAgent(brain, fakeServices())
    const config = readMcpConfig(reg.configPath)
    expect((await rawPost(config.url, config.headers, undefined, 'GET')).status).toBe(405)
    const other = await rawPost(config.url.replace('/mcp', '/other'), config.headers, {})
    expect(other.status).toBe(404)
  })

  it('binds to 127.0.0.1 on a random port', () => {
    expect(bridge.port).toBeGreaterThan(0)
    expect(bridge.url).toBe(`http://127.0.0.1:${bridge.port}/mcp`)
  })
})

describe('tools by role', () => {
  it('shows each role its own tools (request_permission is for both)', async () => {
    const brainConfig = readMcpConfig(bridge.registerAgent(brain, fakeServices()).configPath)
    const workerConfig = readMcpConfig(bridge.registerAgent(worker, fakeServices()).configPath)
    expect(await listTools(brainConfig)).toEqual([
      'ask_user',
      'escalate_to_user',
      'get_worker_status',
      'merge_worker',
      'message_worker',
      'propose_plan',
      'request_permission',
      'resolve_request',
      'spawn_worker',
      'sync_worker'
    ])
    expect(await listTools(workerConfig)).toEqual([
      'ask_brain',
      'report_done',
      'report_progress',
      'request_permission'
    ])
  })

  it('does not offer request_permission to a Cursor agent', async () => {
    const cursorWorker = { ...worker, agentId: 'cursor-w', provider: 'cursor' as const }
    const config = readMcpConfig(bridge.registerAgent(cursorWorker, fakeServices()).configPath)
    expect(await listTools(config)).toEqual([
      'ask_brain',
      'report_done',
      'report_progress',
      'wait_for'
    ])
  })

  it('refuses a call to a tool of the other role', async () => {
    const workerConfig = readMcpConfig(bridge.registerAgent(worker, fakeServices()).configPath)
    const services = fakeServices()
    const brainConfig = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const asWorker = await mcpRequest(workerConfig, 'tools/call', {
      name: 'spawn_worker',
      arguments: { name: 'x', task: 't', repos: ['a'] }
    })
    const failed =
      asWorker['error'] !== undefined ||
      (asWorker['result'] as { isError?: boolean } | undefined)?.isError === true
    expect(failed).toBe(true)
    expect(services.spawnWorker).not.toHaveBeenCalled()
    const asBrain = await mcpRequest(brainConfig, 'tools/call', {
      name: 'report_done',
      arguments: { summary: 's' }
    })
    expect(
      asBrain['error'] !== undefined ||
        (asBrain['result'] as { isError?: boolean } | undefined)?.isError === true
    ).toBe(true)
  })

  it('returns JSON text and passes the caller identity from the token', async () => {
    const services = fakeServices()
    const config = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const outcome = await callTool(config, 'spawn_worker', {
      name: 'api-retry',
      task: 'do it',
      repos: ['api']
    })
    expect(outcome).toEqual({
      isError: false,
      value: { workerId: 'w1', status: 'started', provider: 'claude', model: 'sonnet', note: null }
    })
    expect(services.spawnWorker).toHaveBeenCalledWith(brain, {
      name: 'api-retry',
      task: 'do it',
      repos: ['api'],
      model: undefined,
      dependsOn: undefined
    })
  })

  it('turns a BridgeToolError into an error result with its code', async () => {
    const services = fakeServices({
      spawnWorker: () => Promise.reject(new BridgeToolError('plan_not_approved', 'no plan'))
    })
    const config = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const outcome = await callTool(config, 'spawn_worker', { name: 'x', task: 't', repos: ['a'] })
    expect(outcome).toEqual({
      isError: true,
      value: { error: 'plan_not_approved', message: 'no plan' }
    })
  })

  it('rejects arguments that do not match the schema', async () => {
    const services = fakeServices()
    const config = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const answer = await mcpRequest(config, 'tools/call', {
      name: 'spawn_worker',
      arguments: { name: 'x' }
    })
    const result = answer['result'] as { isError?: boolean } | undefined
    expect(answer['error'] !== undefined || result?.isError === true).toBe(true)
    expect(services.spawnWorker).not.toHaveBeenCalled()
  })
})

describe('agent registration', () => {
  it('writes the config file with mode 0600 in the CLI shape, and deletes it on revoke', async () => {
    const reg = bridge.registerAgent(brain, fakeServices())
    expect(reg.configPath).toBe(join(dir(), 'mcp', 'brain-s1.json'))
    expect(statSync(reg.configPath).mode & 0o777).toBe(0o600)
    const config = readMcpConfig(reg.configPath)
    expect(config.url).toBe(bridge.url)
    expect(config.headers['Authorization']).toBe(`Bearer ${reg.token}`)
    expect(reg.token).toMatch(/^[0-9a-f]{64}$/)
    expect(
      (await rawPost(config.url, config.headers, { jsonrpc: '2.0', id: 1, method: 'tools/list' }))
        .status
    ).toBe(200)

    bridge.revokeAgent('brain-s1')
    expect(existsSync(reg.configPath)).toBe(false)
    const after = await rawPost(config.url, config.headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    })
    expect(after.status).toBe(401)
  })

  it('mints a new token when an agent is registered again (a respawn)', () => {
    const first = bridge.registerAgent(brain, fakeServices())
    const second = bridge.registerAgent(brain, fakeServices())
    expect(second.token).not.toBe(first.token)
    expect(readMcpConfig(second.configPath).headers['Authorization']).toBe(`Bearer ${second.token}`)
  })

  it('aborts a blocking call when its agent is revoked', async () => {
    let aborted = false
    const services = fakeServices({
      proposePlan: (_agent, _input, call) =>
        new Promise((_resolve, reject) => {
          call.signal.addEventListener('abort', () => {
            aborted = true
            reject(new BridgeToolError('cancelled', 'gone'))
          })
        })
    })
    const config = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const pending = callTool(config, 'propose_plan', {
      workers: [{ name: 'a', task: 't', repos: ['api'] }]
    })
    await new Promise((r) => setTimeout(r, 100))
    bridge.revokeAgent('brain-s1')
    const outcome = await pending
    expect(aborted).toBe(true)
    expect(outcome.isError).toBe(true)
  })

  it('sends progress notifications while a blocking call waits', async () => {
    const services = fakeServices({
      proposePlan: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ planId: 'p1', decision: 'rejected' as const }), 200)
        )
    })
    const config = readMcpConfig(bridge.registerAgent(brain, services).configPath)
    const res = await rawPost(config.url, config.headers, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'propose_plan',
        arguments: { workers: [{ name: 'a', task: 't', repos: ['api'] }] },
        _meta: { progressToken: 'tok' }
      }
    })
    expect(res.body).toContain('notifications/progress')
    expect(res.body).toContain('"progressToken":"tok"')
    expect(res.body).toContain('rejected')
  })

  it("keeps a worker's ask_brain alive with progress, and a quick tool gets none", async () => {
    const services = fakeServices({
      askBrain: () => new Promise((resolve) => setTimeout(() => resolve({ answer: 'yes' }), 200)),
      reportDone: () =>
        new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), 200))
    })
    const config = readMcpConfig(bridge.registerAgent(worker, services).configPath)
    const call = (name: string, args: Record<string, unknown>): Promise<{ body: string }> =>
      rawPost(config.url, config.headers, {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: { name, arguments: args, _meta: { progressToken: 1 } }
      })

    const asked = await call('ask_brain', { question: 'Use Redis?' })
    expect(asked.body).toContain('notifications/progress')
    expect(asked.body).toContain('"progressToken":1')

    const done = await call('report_done', { summary: 'ok' })
    expect(done.body).not.toContain('notifications/progress')
  })

  it('sends no progress without a progress token', async () => {
    const services = fakeServices({
      askBrain: () => new Promise((resolve) => setTimeout(() => resolve({ answer: 'yes' }), 200))
    })
    const config = readMcpConfig(bridge.registerAgent(worker, services).configPath)
    const res = await rawPost(config.url, config.headers, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'ask_brain', arguments: { question: 'Use Redis?' } }
    })
    expect(res.body).not.toContain('notifications/progress')
    expect(res.body).toContain('yes')
  })

  it('refuses to register before the server is listening', async () => {
    const idle = new BridgeServer({
      configDir: join(dir(), 'idle'),
      log: { warn: vi.fn(), error: vi.fn() }
    })
    expect(() => idle.registerAgent(brain, fakeServices())).toThrow(/not running/)
  })
})
