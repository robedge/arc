import { describe, expect, it } from 'vitest'
import {
  CodexRpc,
  RpcClosedError,
  RpcError,
  RpcTimeoutError
} from '../../../../src/main/agents/codex/codex-rpc'

function rig(): { rpc: CodexRpc; sent: Record<string, unknown>[]; alive: { value: boolean } } {
  const sent: Record<string, unknown>[] = []
  const alive = { value: true }
  const rpc = new CodexRpc(
    {
      writeLine: (line) => {
        if (!alive.value) return false
        sent.push(JSON.parse(line) as Record<string, unknown>)
        return true
      }
    },
    200
  )
  return { rpc, sent, alive }
}

describe('CodexRpc', () => {
  it('writes a request without a jsonrpc field and resolves with the matching result', async () => {
    const { rpc, sent } = rig()
    const first = rpc.request('thread/start', { cwd: '/w' })
    const second = rpc.request('model/list')
    expect(sent).toEqual([
      { id: 1, method: 'thread/start', params: { cwd: '/w' } },
      { id: 2, method: 'model/list' }
    ])
    // answered out of order: each promise gets its own result
    rpc.handleLine(JSON.stringify({ id: 2, result: { models: [] } }))
    rpc.handleLine(JSON.stringify({ id: 1, result: { thread: { id: 't1' } } }))
    await expect(first).resolves.toEqual({ thread: { id: 't1' } })
    await expect(second).resolves.toEqual({ models: [] })
    expect(rpc.pendingCount).toBe(0)
  })

  it('rejects with the error object of an error response', async () => {
    const { rpc } = rig()
    const call = rpc.request('turn/steer')
    rpc.handleLine(
      JSON.stringify({ id: 1, error: { code: -32600, message: 'no active turn to steer' } })
    )
    const error = await call.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({
      method: 'turn/steer',
      code: -32600,
      message: 'no active turn to steer'
    })
  })

  it('keeps the two id namespaces apart: a server request with our id is not our response', async () => {
    const { rpc } = rig()
    const requests: unknown[] = []
    rpc.onServerRequest((r) => requests.push(r))
    const call = rpc.request('turn/start')
    // The server's own request number 1 arrives; it carries a method, so it is not the answer to ours.
    rpc.handleLine(
      JSON.stringify({ id: 1, method: 'item/commandExecution/requestApproval', params: { a: 1 } })
    )
    expect(requests).toEqual([
      { id: 1, method: 'item/commandExecution/requestApproval', params: { a: 1 } }
    ])
    expect(rpc.pendingCount).toBe(1)
    rpc.handleLine(JSON.stringify({ id: 1, result: {} }))
    await expect(call).resolves.toEqual({})
  })

  it('routes notifications, and answers server requests with the same id', () => {
    const { rpc, sent } = rig()
    const seen: [string, unknown][] = []
    rpc.onNotification((method, params) => seen.push([method, params]))
    rpc.handleLine(JSON.stringify({ method: 'turn/started', params: { turn: { id: 't' } } }))
    rpc.handleLine(JSON.stringify({ method: 'initialized' }))
    expect(seen).toEqual([
      ['turn/started', { turn: { id: 't' } }],
      ['initialized', {}]
    ])
    rpc.respond(7, { decision: 'accept' })
    rpc.respondError('abc', -32601, 'nope')
    expect(sent).toEqual([
      { id: 7, result: { decision: 'accept' } },
      { id: 'abc', error: { code: -32601, message: 'nope' } }
    ])
  })

  it('reports lines that are not JSON-RPC and never throws', () => {
    const { rpc } = rig()
    const invalid: string[] = []
    rpc.onInvalid((line) => invalid.push(line))
    rpc.handleLine('not json')
    rpc.handleLine('[1,2]')
    rpc.handleLine('{"nothing":true}')
    rpc.handleLine(JSON.stringify({ id: 99, result: {} })) // an answer nobody asked for
    expect(invalid).toEqual(['not json', '[1,2]', '{"nothing":true}'])
  })

  it('times out a request that is never answered', async () => {
    const { rpc } = rig()
    const call = rpc.request('account/read', undefined, 20)
    await expect(call).rejects.toBeInstanceOf(RpcTimeoutError)
    expect(rpc.pendingCount).toBe(0)
  })

  it('rejects at once when the process is gone, and when it closes with requests waiting', async () => {
    const { rpc, alive } = rig()
    const waiting = rpc.request('turn/start')
    rpc.close()
    await expect(waiting).rejects.toBeInstanceOf(RpcClosedError)
    await expect(rpc.request('later')).rejects.toBeInstanceOf(RpcClosedError)

    const second = rig()
    second.alive.value = false
    await expect(second.rpc.request('initialize')).rejects.toBeInstanceOf(RpcClosedError)
    expect(alive.value).toBe(true)
  })
})
