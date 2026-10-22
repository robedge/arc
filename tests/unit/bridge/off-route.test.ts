import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeServer } from '../../../src/main/bridge/bridge-server'
import type { BridgeAgent, BridgeServices } from '../../../src/main/bridge/types'
import { parseRpc, rawPost, readMcpConfig } from '../helpers/mcp-client'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-bridge-off-')
let bridge: BridgeServer
const worker: BridgeAgent = {
  sessionId: 's1',
  agentId: 'worker-w1',
  role: 'worker',
  provider: 'cursor'
}

beforeEach(async () => {
  bridge = new BridgeServer({
    configDir: join(dir(), 'mcp'),
    log: { warn: vi.fn(), error: vi.fn() }
  })
  await bridge.start()
})
afterEach(async () => {
  await bridge.close()
})

function offUrl(name: string): string {
  return bridge.url.replace(/\/mcp$/, `/off/${encodeURIComponent(name)}`)
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'Cursor', version: '1.0.0' }
  }
}

describe('the /off/<server> route', () => {
  it('answers initialize and an empty tools/list under the agent token', async () => {
    const reg = bridge.registerAgent(worker, {} as BridgeServices)
    const headers = { authorization: `Bearer ${reg.token}` }
    const init = await rawPost(offUrl('github'), headers, initialize)
    expect(init.status).toBe(200)
    expect(parseRpc(init.body, 1)['result']).toMatchObject({ capabilities: { tools: {} } })
    const list = await rawPost(offUrl('github'), headers, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    })
    expect(list.status).toBe(200)
    expect(parseRpc(list.body, 2)['result']).toEqual({ tools: [] })
    const note = await rawPost(offUrl('github'), headers, {
      jsonrpc: '2.0',
      method: 'notifications/initialized'
    })
    expect(note.status).toBe(202)
  })

  it('needs the token', async () => {
    bridge.registerAgent(worker, {} as BridgeServices)
    expect((await rawPost(offUrl('github'), {}, initialize)).status).toBe(401)
    expect(
      (await rawPost(offUrl('github'), { authorization: 'Bearer nope' }, initialize)).status
    ).toBe(401)
    const reg = readMcpConfig(bridge.registerAgent(worker, {} as BridgeServices).configPath)
    expect((await rawPost(offUrl('github'), reg.headers, initialize)).status).toBe(200)
  })

  it('rejects every other method and a GET', async () => {
    const reg = bridge.registerAgent(worker, {} as BridgeServices)
    const headers = { authorization: `Bearer ${reg.token}` }
    for (const [id, method] of [
      [3, 'tools/call'],
      [4, 'resources/list'],
      [5, 'prompts/list']
    ] as const) {
      const res = await rawPost(offUrl('github'), headers, {
        jsonrpc: '2.0',
        id,
        method,
        params: { name: 'anything', arguments: {} }
      })
      const error = parseRpc(res.body, id)['error'] as { code: number }
      expect(error.code).toBe(-32601)
    }
    expect((await rawPost(offUrl('github'), headers, undefined, 'GET')).status).toBe(405)
  })

  it('does not serve the arc tools there', async () => {
    const reg = bridge.registerAgent(worker, {} as BridgeServices)
    const res = await rawPost(
      offUrl('arc'),
      { authorization: `Bearer ${reg.token}` },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list'
      }
    )
    expect(parseRpc(res.body, 7)['result']).toEqual({ tools: [] })
  })
})
