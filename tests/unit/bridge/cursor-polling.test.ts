import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeServer } from '../../../src/main/bridge/bridge-server'
import type { BridgeAgent, BridgeServices } from '../../../src/main/bridge/types'
import { callTool, listTools, mcpRequest, readMcpConfig } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-bridge-poll-')
let bridge: BridgeServer

const POLL_MS = 80
const base = { sessionId: 's1', agentId: 'worker-w1', role: 'worker' } as const
const cursorWorker: BridgeAgent = { ...base, provider: 'cursor' }
const claudeWorker: BridgeAgent = { ...base, agentId: 'worker-w2', provider: 'claude' }
const cursorBrain: BridgeAgent = {
  sessionId: 's1',
  agentId: 'brain-s1',
  role: 'brain',
  provider: 'cursor'
}

function services(overrides: Partial<BridgeServices>): BridgeServices {
  return {
    askBrain: vi.fn(() => Promise.resolve({ answer: 'yes' })),
    reportProgress: vi.fn(() => ({ ok: true as const })),
    ...overrides
  } as unknown as BridgeServices
}

/** An `ask_brain` that answers after `ms`. */
const slowAnswer =
  (ms: number): BridgeServices['askBrain'] =>
  () =>
    new Promise<{ answer: string }>((resolve) =>
      setTimeout(() => resolve({ answer: 'late yes' }), ms)
    )

beforeEach(async () => {
  bridge = new BridgeServer({
    configDir: join(dir(), 'mcp'),
    log: { warn: vi.fn(), error: vi.fn() },
    pollMs: POLL_MS
  })
  await bridge.start()
})
afterEach(async () => {
  await bridge.close()
})

describe('Cursor agents get the polling shape', () => {
  it('returns pending after the cut, then the final result through wait_for', async () => {
    const config = readMcpConfig(
      bridge.registerAgent(cursorWorker, services({ askBrain: slowAnswer(POLL_MS * 2 + 40) }))
        .configPath
    )
    const first = await callTool(config, 'ask_brain', { question: 'Use Redis?' })
    expect(first.isError).toBe(false)
    expect(first.value).toMatchObject({
      status: 'pending',
      waitId: expect.any(String) as unknown,
      message: expect.stringContaining('Call wait_for(waitId)') as unknown
    })
    const waitId = String(first.value['waitId'])

    const second = await callTool(config, 'wait_for', { waitId })
    expect(second.value).toMatchObject({ status: 'pending', waitId })

    const third = await callTool(config, 'wait_for', { waitId })
    expect(third.isError).toBe(false)
    expect(third.value).toEqual({ answer: 'late yes' })

    const gone = await callTool(config, 'wait_for', { waitId })
    expect(gone.isError).toBe(true)
    expect(gone.value['error']).toBe('unknown_wait_id')
  })

  it('answers a call that finishes before the cut normally', async () => {
    const config = readMcpConfig(
      bridge.registerAgent(cursorWorker, services({ askBrain: slowAnswer(10) })).configPath
    )
    const result = await callTool(config, 'ask_brain', { question: 'Use Redis?' })
    expect(result.value).toEqual({ answer: 'late yes' })
  })

  it('keeps the error of a call that fails after it went pending', async () => {
    const config = readMcpConfig(
      bridge.registerAgent(
        cursorWorker,
        services({
          askBrain: () =>
            new Promise((_resolve, reject) =>
              setTimeout(() => reject(new Error('boom: internal detail')), POLL_MS + 40)
            )
        })
      ).configPath
    )
    const first = await callTool(config, 'ask_brain', { question: 'q' })
    const done = await callTool(config, 'wait_for', { waitId: String(first.value['waitId']) })
    expect(done.isError).toBe(true)
    expect(done.value['error']).toBe('internal')
  })

  it('offers wait_for to a Cursor agent only', async () => {
    const cursor = readMcpConfig(bridge.registerAgent(cursorWorker, services({})).configPath)
    const claude = readMcpConfig(bridge.registerAgent(claudeWorker, services({})).configPath)
    expect(await listTools(cursor)).toContain('wait_for')
    expect(await listTools(claude)).not.toContain('wait_for')
    const refused = await mcpRequest(claude, 'tools/call', {
      name: 'wait_for',
      arguments: { waitId: 'w_x' }
    })
    expect(JSON.stringify(refused)).toMatch(/Tool wait_for not found/)
  })

  it('applies to the brain tools too (propose_plan waits for the user)', async () => {
    const config = readMcpConfig(
      bridge.registerAgent(
        cursorBrain,
        services({
          proposePlan: () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ planId: 'p1', decision: 'rejected' }), POLL_MS * 2)
            )
        })
      ).configPath
    )
    const first = await callTool(config, 'propose_plan', {
      workers: [{ name: 'a', task: 't', repos: ['api'] }]
    })
    expect(first.value).toMatchObject({
      status: 'pending',
      message:
        'Still waiting for the user to decide on the plan. Call wait_for(waitId) to keep waiting.'
    })
    const waitId = String(first.value['waitId'])
    let final = await callTool(config, 'wait_for', { waitId })
    if (final.value['status'] === 'pending') final = await callTool(config, 'wait_for', { waitId })
    expect(final.value).toEqual({ planId: 'p1', decision: 'rejected' })
  })

  it('aborts a pending call when the agent is revoked', async () => {
    let aborted = false
    const config = readMcpConfig(
      bridge.registerAgent(
        cursorWorker,
        services({
          askBrain: (_agent, _input, call) =>
            new Promise((_resolve, reject) => {
              call.signal.addEventListener('abort', () => {
                aborted = true
                reject(new Error('aborted'))
              })
            })
        })
      ).configPath
    )
    const first = await callTool(config, 'ask_brain', { question: 'q' })
    expect(first.value['status']).toBe('pending')
    bridge.revokeAgent('worker-w1')
    await vi.waitFor(() => expect(aborted).toBe(true))
  })
})

describe('Claude and Codex agents are unchanged', () => {
  it.each(['claude', 'codex', undefined] as const)(
    'a %s agent waits for the whole call and never sees pending',
    async (provider) => {
      const agent: BridgeAgent = { ...claudeWorker, ...(provider ? { provider } : {}) }
      const config = readMcpConfig(
        bridge.registerAgent(agent, services({ askBrain: slowAnswer(POLL_MS * 3) })).configPath
      )
      const result = await callTool(config, 'ask_brain', { question: 'Use Redis?' })
      expect(result.value).toEqual({ answer: 'late yes' })
    }
  )
})
