import { describe, expect, it } from 'vitest'
import {
  JsonRpcPeer,
  RpcClosedError,
  RpcError,
  RpcTimeoutError
} from '../../../../src/main/agents/rpc/json-rpc-peer'

function rig(jsonrpc: boolean): { peer: JsonRpcPeer; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = []
  const peer = new JsonRpcPeer(
    {
      writeLine: (line) => {
        sent.push(JSON.parse(line) as Record<string, unknown>)
        return true
      }
    },
    200,
    { jsonrpc, peerName: 'The test peer' }
  )
  return { peer, sent }
}

describe('JsonRpcPeer', () => {
  it('leaves the jsonrpc field out by default and writes it on every message when asked', () => {
    const plain = rig(false)
    void plain.peer.request('a', { x: 1 }).catch(() => undefined)
    plain.peer.notify('b')
    plain.peer.respond(0, {})
    plain.peer.respondError(1, -32601, 'no')
    expect(plain.sent.every((m) => !('jsonrpc' in m))).toBe(true)

    const versioned = rig(true)
    void versioned.peer.request('a', { x: 1 }).catch(() => undefined)
    versioned.peer.notify('b')
    versioned.peer.respond(0, {}) // a server request id of 0 is a valid id
    versioned.peer.respondError(1, -32601, 'no')
    expect(versioned.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'a', params: { x: 1 } },
      { jsonrpc: '2.0', method: 'b' },
      { jsonrpc: '2.0', id: 0, result: {} },
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'no' } }
    ])
  })

  it('treats a server request with id 0 as a request, not a response', () => {
    const { peer } = rig(true)
    const seen: unknown[] = []
    peer.onServerRequest((r) => seen.push(r))
    peer.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'session/request_permission' }))
    expect(seen).toEqual([{ id: 0, method: 'session/request_permission', params: {} }])
  })

  it('names the peer in timeout and closed errors', async () => {
    const { peer } = rig(true)
    const timedOut = peer.request('slow', undefined, 10)
    await expect(timedOut).rejects.toBeInstanceOf(RpcTimeoutError)
    await expect(timedOut).rejects.toThrow('The test peer did not answer slow within 10 ms.')
    const waiting = peer.request('later')
    peer.close()
    await expect(waiting).rejects.toBeInstanceOf(RpcClosedError)
    await expect(waiting).rejects.toThrow('The test peer is not running.')
  })

  it('waits without a timer for a request sent with an infinite timeout', async () => {
    const { peer } = rig(true)
    const call = peer.request('session/prompt', {}, Infinity)
    await new Promise((r) => setTimeout(r, 300)) // longer than the 200 ms default
    expect(peer.pendingCount).toBe(1)
    peer.handleLine(JSON.stringify({ id: 1, result: { stopReason: 'end_turn' } }))
    await expect(call).resolves.toEqual({ stopReason: 'end_turn' })
  })

  it('rejects with the error object of an error response, with its code', async () => {
    const { peer } = rig(true)
    const call = peer.request('authenticate')
    peer.handleLine(
      JSON.stringify({ id: 1, error: { code: -32000, message: 'Authentication required' } })
    )
    const error = await call.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RpcError)
    expect(error).toMatchObject({ method: 'authenticate', code: -32000 })
  })
})
