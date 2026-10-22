import {
  JsonRpcPeer,
  RpcError,
  type JsonObject,
  type JsonRpcId,
  type RpcServerRequest,
  type RpcTransport
} from '../rpc/json-rpc-peer'
import {
  ACP_AUTH_REQUIRED,
  ACP_INVALID_PARAMS,
  ACP_PROTOCOL_VERSION,
  CURSOR_AUTH_METHOD,
  initializeResponseSchema,
  promptResponseSchema,
  sessionResponseSchema,
  type CursorSessionResponse
} from './cursor-types'

/**
 * Typed calls over `agent acp` (Agent Client Protocol, JSON-RPC 2.0 over stdio). A thin layer on
 * `JsonRpcPeer`: it sends the `jsonrpc` field (Cursor does not require it, spike N1, but it is
 * harmless), validates the few answers Arc reads, and leaves everything else to the adapter.
 */

/** The `session/new` and `session/load` MCP server entry for an http server. */
export interface AcpHttpMcpServer {
  type: 'http'
  name: string
  url: string
  headers: { name: string; value: string }[]
}

export interface AcpSessionParams {
  cwd: string
  mcpServers: AcpHttpMcpServer[]
}

/** True when the server said the login is missing (`authenticate` or `session/new`, -32000). */
export function isAuthRequired(error: unknown): boolean {
  return error instanceof RpcError && error.code === ACP_AUTH_REQUIRED
}

/** True for -32602, which is also what `session/load` answers for a session it does not have. */
export function isInvalidParams(error: unknown): boolean {
  return error instanceof RpcError && error.code === ACP_INVALID_PARAMS
}

export class AcpClient {
  private readonly peer: JsonRpcPeer

  constructor(transport: RpcTransport, requestTimeoutMs: number) {
    this.peer = new JsonRpcPeer(transport, requestTimeoutMs, {
      jsonrpc: true,
      peerName: 'The Cursor ACP server'
    })
  }

  onNotification(listener: (method: string, params: JsonObject) => void): void {
    this.peer.onNotification(listener)
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): void {
    this.peer.onServerRequest(listener)
  }

  onInvalid(listener: (line: string) => void): void {
    this.peer.onInvalid(listener)
  }

  handleLine(line: string): void {
    this.peer.handleLine(line)
  }

  close(): void {
    this.peer.close()
  }

  /** No `fs` or `terminal` client capabilities: Cursor then uses its own tools and every action reaches the permission request. */
  async initialize(): Promise<void> {
    const reply = initializeResponseSchema.safeParse(
      await this.peer.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {}
      })
    )
    if (!reply.success) throw new Error('Cursor answered initialize with an unexpected shape.')
  }

  async authenticate(): Promise<void> {
    await this.peer.request('authenticate', { methodId: CURSOR_AUTH_METHOD })
  }

  async newSession(
    params: AcpSessionParams
  ): Promise<CursorSessionResponse & { sessionId: string }> {
    const reply = sessionResponseSchema.safeParse(
      await this.peer.request('session/new', { ...params })
    )
    if (!reply.success || !reply.data.sessionId) {
      throw new Error('Cursor answered session/new with an unexpected shape.')
    }
    return { ...reply.data, sessionId: reply.data.sessionId }
  }

  /** Replays the session's history as `session/update` notifications first; the caller drops them until this resolves. */
  async loadSession(sessionId: string, params: AcpSessionParams): Promise<CursorSessionResponse> {
    const reply = sessionResponseSchema.safeParse(
      await this.peer.request('session/load', { sessionId, ...params })
    )
    if (!reply.success) throw new Error('Cursor answered session/load with an unexpected shape.')
    return reply.data
  }

  async setMode(sessionId: string, modeId: string): Promise<void> {
    await this.peer.request('session/set_mode', { sessionId, modeId })
  }

  /** `modelId` is the whole bracketed string (`gpt-5.4-mini[reasoning=medium]`); an unknown one fails with -32602. */
  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.peer.request('session/set_model', { sessionId, modelId })
  }

  /**
   * Resolves with the stop reason when the turn ends, and the `usage` (or `_meta.usage`) of the
   * response if Cursor sent one. It waits for as long as the turn runs.
   */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string; usage?: unknown }> {
    const reply = promptResponseSchema.safeParse(
      await this.peer.request(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text }] },
        Infinity
      )
    )
    if (!reply.success) throw new Error('Cursor answered session/prompt with an unexpected shape.')
    const meta: unknown = reply.data['_meta']
    const usage =
      reply.data['usage'] ??
      (typeof meta === 'object' && meta !== null ? (meta as { usage?: unknown }).usage : undefined)
    return usage === undefined
      ? { stopReason: reply.data.stopReason }
      : { stopReason: reply.data.stopReason, usage }
  }

  /** ACP's `session/cancel` is a notification; the prompt then ends with `stopReason: cancelled`. */
  cancel(sessionId: string): boolean {
    return this.peer.notify('session/cancel', { sessionId })
  }

  /** The answer to `session/request_permission`: a chosen option, or `cancelled`. */
  answerPermission(id: JsonRpcId, optionId: string | undefined): boolean {
    return this.peer.respond(id, {
      outcome: optionId === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId }
    })
  }

  /** Answers a server request this client does not handle. */
  rejectRequest(id: JsonRpcId, code: number, message: string): boolean {
    return this.peer.respondError(id, code, message)
  }

  get pendingCount(): number {
    return this.peer.pendingCount
  }
}
