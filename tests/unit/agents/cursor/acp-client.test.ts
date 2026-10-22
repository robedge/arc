import { describe, expect, it } from 'vitest'
import {
  AcpClient,
  isAuthRequired,
  isInvalidParams
} from '../../../../src/main/agents/cursor/acp-client'
import { RpcError } from '../../../../src/main/agents/rpc/json-rpc-peer'

type Msg = Record<string, unknown>

/** A scripted in-memory peer: `answer` decides the reply to each request the client writes. */
function rig(answer: (msg: Msg) => Msg | undefined): { client: AcpClient; sent: Msg[] } {
  const sent: Msg[] = []
  const client: AcpClient = new AcpClient(
    {
      writeLine: (line) => {
        const msg = JSON.parse(line) as Msg
        sent.push(msg)
        const reply = answer(msg)
        if (reply)
          queueMicrotask(() =>
            client.handleLine(JSON.stringify({ jsonrpc: '2.0', id: msg['id'], ...reply }))
          )
        return true
      }
    },
    500
  )
  return { client, sent }
}

describe('AcpClient', () => {
  it('sends the handshake and session calls with the params the spikes found, jsonrpc on every message', async () => {
    const { client, sent } = rig((msg) => {
      if (msg['method'] === 'initialize')
        return { result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }
      if (msg['method'] === 'session/new') {
        return {
          result: {
            sessionId: 'session-1',
            modes: { currentModeId: 'agent' },
            models: {
              currentModelId: 'default[]',
              availableModels: [{ modelId: 'default[]', name: 'Auto' }]
            }
          }
        }
      }
      if (msg['method'] === 'session/prompt') return { result: { stopReason: 'end_turn' } }
      if (msg['method'] === 'session/load') return { result: {} }
      return { result: {} }
    })
    await client.initialize()
    await client.authenticate()
    const mcp = {
      type: 'http' as const,
      name: 'arc',
      url: 'http://127.0.0.1:1/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer t' }]
    }
    const created = await client.newSession({ cwd: '/w', mcpServers: [mcp] })
    expect(created.sessionId).toBe('session-1')
    expect(created.models?.availableModels?.[0]?.name).toBe('Auto')
    await client.loadSession('session-1', { cwd: '/w', mcpServers: [] })
    await client.setMode('session-1', 'agent')
    await client.setModel('session-1', 'gpt-5.4-mini[reasoning=medium]')
    await expect(client.prompt('session-1', 'hello')).resolves.toEqual({ stopReason: 'end_turn' })
    expect(client.cancel('session-1')).toBe(true)
    client.answerPermission(0, 'allow-once')
    client.answerPermission(1, undefined)

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: {} }
      },
      { jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cursor_login' } },
      { jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: '/w', mcpServers: [mcp] } },
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'session/load',
        params: { sessionId: 'session-1', cwd: '/w', mcpServers: [] }
      },
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'session/set_mode',
        params: { sessionId: 'session-1', modeId: 'agent' }
      },
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'session/set_model',
        params: { sessionId: 'session-1', modelId: 'gpt-5.4-mini[reasoning=medium]' }
      },
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'session/prompt',
        params: { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] }
      },
      // cancel is a notification (no id)
      { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 'session-1' } },
      // a request id of 0 is answered as 0
      {
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
      },
      { jsonrpc: '2.0', id: 1, result: { outcome: { outcome: 'cancelled' } } }
    ])
  })

  it('classifies the errors the spikes saw: -32000 needs login, -32602 is invalid params', async () => {
    const { client } = rig((msg) =>
      msg['method'] === 'authenticate'
        ? { error: { code: -32000, message: 'Authentication required' } }
        : {
            error: {
              code: -32602,
              message: 'Invalid params',
              data: { message: 'Session "x" not found' }
            }
          }
    )
    const auth = await client.authenticate().catch((e: unknown) => e)
    expect(auth).toBeInstanceOf(RpcError)
    expect(isAuthRequired(auth)).toBe(true)
    expect(isInvalidParams(auth)).toBe(false)
    const load = await client
      .loadSession('x', { cwd: '/w', mcpServers: [] })
      .catch((e: unknown) => e)
    expect(isInvalidParams(load)).toBe(true)
    expect(isAuthRequired(new Error('plain'))).toBe(false)
  })

  it('rejects an answer of the wrong shape and keeps a prompt open for as long as it runs', async () => {
    const odd = rig(() => ({ result: { nope: true } }))
    await expect(odd.client.newSession({ cwd: '/w', mcpServers: [] })).rejects.toThrow(
      /unexpected shape/
    )
    await expect(odd.client.prompt('s', 'hi')).rejects.toThrow(/unexpected shape/)

    // The request timeout is 500 ms here; a prompt must outlive it.
    const { client } = rig((msg) =>
      msg['method'] === 'session/prompt' ? undefined : { result: {} }
    )
    const turn = client.prompt('s', 'long')
    await new Promise((r) => setTimeout(r, 700))
    client.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'cancelled' } })
    )
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
  })

  it('hands notifications and server requests (id 0 included) to its listeners', () => {
    const { client } = rig(() => undefined)
    const seen: unknown[] = []
    client.onNotification((method, params) => seen.push([method, params]))
    client.onServerRequest((r) => seen.push(r))
    client.handleLine(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { a: 1 } })
    )
    client.handleLine(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'session/request_permission',
        params: { b: 2 }
      })
    )
    expect(seen).toEqual([
      ['session/update', { a: 1 }],
      { id: 0, method: 'session/request_permission', params: { b: 2 } }
    ])
  })
})
