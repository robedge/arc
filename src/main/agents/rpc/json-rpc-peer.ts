/**
 * JSON-RPC over a child's stdio, one JSON object per line, shared by the Codex app-server and the
 * Cursor ACP server. Messages are told apart by their shape:
 * - `id` and `method`: a request (ours to the server, or the server's to us),
 * - `method` only: a notification,
 * - `id` and `result` or `error`: the response to a request of ours.
 *
 * The two sides number their requests independently, so a response is matched only against the
 * requests this side sent. The Codex app-server leaves the `jsonrpc` field out; Cursor does not
 * require it. `jsonrpc: true` writes `"jsonrpc":"2.0"` on every message we send.
 */

export type JsonRpcId = number | string
export type JsonObject = Record<string, unknown>

export interface RpcTransport {
  /** Writes one line (a newline is added). False when the process is gone. */
  writeLine(line: string): boolean
}

export interface RpcServerRequest {
  id: JsonRpcId
  method: string
  params: JsonObject
}

/** The server answered a request with an error object. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

/** No answer arrived in time. */
export class RpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    peerName = 'The JSON-RPC peer'
  ) {
    super(`${peerName} did not answer ${method} within ${timeoutMs} ms.`)
    this.name = 'RpcTimeoutError'
  }
}

/** The process ended (or was never reachable) before the answer came. */
export class RpcClosedError extends Error {
  constructor(message = 'The JSON-RPC peer is not running.') {
    super(message)
    this.name = 'RpcClosedError'
  }
}

export const DEFAULT_RPC_TIMEOUT_MS = 30_000

export interface JsonRpcPeerOptions {
  /** Write `"jsonrpc":"2.0"` on every message. Off by default (the Codex app-server leaves it out). */
  jsonrpc?: boolean
  /** How the peer is named in timeout and closed errors, for example "The Codex app-server". */
  peerName?: string
}

interface Pending {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'number' || typeof value === 'string'
}

export class JsonRpcPeer {
  private nextId = 0
  private readonly pending = new Map<JsonRpcId, Pending>()
  private readonly notificationListeners: ((method: string, params: JsonObject) => void)[] = []
  private readonly requestListeners: ((request: RpcServerRequest) => void)[] = []
  private readonly invalidListeners: ((line: string) => void)[] = []
  private closedWith: Error | undefined
  private readonly peerName: string
  private readonly versionField: { jsonrpc: '2.0' } | Record<string, never>

  constructor(
    private readonly transport: RpcTransport,
    private readonly defaultTimeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    options: JsonRpcPeerOptions = {}
  ) {
    this.peerName = options.peerName ?? 'The JSON-RPC peer'
    this.versionField = options.jsonrpc ? { jsonrpc: '2.0' } : {}
  }

  onNotification(listener: (method: string, params: JsonObject) => void): void {
    this.notificationListeners.push(listener)
  }

  onServerRequest(listener: (request: RpcServerRequest) => void): void {
    this.requestListeners.push(listener)
  }

  /** A line that is not a JSON-RPC message. */
  onInvalid(listener: (line: string) => void): void {
    this.invalidListeners.push(listener)
  }

  private write(body: Record<string, unknown>): boolean {
    return this.transport.writeLine(JSON.stringify({ ...this.versionField, ...body }))
  }

  /**
   * Sends a request and resolves with its `result`. Rejects on an error response, a timeout or when
   * the process ends. A `timeoutMs` of `Infinity` waits for as long as the process lives.
   */
  request(method: string, params?: JsonObject, timeoutMs?: number): Promise<unknown> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = ++this.nextId
    const ms = timeoutMs ?? this.defaultTimeoutMs
    return new Promise<unknown>((resolve, reject) => {
      const timer = Number.isFinite(ms)
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new RpcTimeoutError(method, ms, this.peerName))
          }, ms)
        : undefined
      this.pending.set(id, { method, resolve, reject, timer })
      const body = params === undefined ? { id, method } : { id, method, params }
      if (!this.write(body)) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new RpcClosedError(`${this.peerName} is not running.`))
      }
    })
  }

  /** Sends a notification (no answer expected). False when the process is gone. */
  notify(method: string, params?: JsonObject): boolean {
    return this.write(params === undefined ? { method } : { method, params })
  }

  /** Answers a server request. */
  respond(id: JsonRpcId, result: unknown): boolean {
    return this.write({ id, result })
  }

  /** Answers a server request with an error. */
  respondError(id: JsonRpcId, code: number, message: string): boolean {
    return this.write({ id, error: { code, message } })
  }

  /** Feeds one stdout line in. Never throws. */
  handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.invalidListeners.forEach((l) => l(line))
      return
    }
    if (!isObject(message)) {
      this.invalidListeners.forEach((l) => l(line))
      return
    }
    const { id, method } = message
    if (typeof method === 'string') {
      const params = isObject(message['params']) ? message['params'] : {}
      if (isId(id)) {
        this.requestListeners.forEach((l) => l({ id, method, params }))
      } else {
        this.notificationListeners.forEach((l) => l(method, params))
      }
      return
    }
    if (!isId(id)) {
      this.invalidListeners.forEach((l) => l(line))
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    const error = message['error']
    if (error !== undefined && error !== null) {
      const body = isObject(error) ? error : {}
      const code = typeof body['code'] === 'number' ? body['code'] : undefined
      const text = typeof body['message'] === 'string' ? body['message'] : JSON.stringify(error)
      entry.reject(new RpcError(entry.method, code, text))
    } else {
      entry.resolve(message['result'])
    }
  }

  /** The process ended: rejects every request still waiting, and every later one. */
  close(error: Error = new RpcClosedError(`${this.peerName} is not running.`)): void {
    if (this.closedWith) return
    this.closedWith = error
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }

  get pendingCount(): number {
    return this.pending.size
  }
}
