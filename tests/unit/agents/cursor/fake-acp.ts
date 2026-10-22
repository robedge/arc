import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  ProcessSupervisor,
  type ChildLike,
  type SpawnFn
} from '../../../../src/main/agents/process-supervisor'
import { sessionNewResult } from './fixtures'

export type Msg = Record<string, unknown>

/**
 * An in-memory `agent acp`: a child process whose stdin the test reads and whose stdout it writes.
 * Requests are answered by `handlers` (by method); anything not handled gets the answer a real
 * Cursor gave in the M1 recording. Signals sent to the process group are recorded, and the process
 * exits only for the signals in `exitOn`.
 */
export class FakeAcp {
  readonly child = new EventEmitter() as EventEmitter & {
    pid: number
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
  }
  /** Everything the client wrote, parsed. */
  readonly received: Msg[] = []
  readonly signals: string[] = []
  spawned: { command: string; args: string[]; cwd: string; env: Record<string, string> }[] = []
  handlers: Record<string, (msg: Msg, fake: FakeAcp) => void> = {}
  exitOn = new Set<string>(['SIGTERM', 'SIGKILL', 'SIGINT'])
  /** Called for each signal before the exit decision. */
  onSignal: ((signal: string) => void) | undefined
  private rest = ''
  private exited = false

  constructor(pid = 4242) {
    this.child.pid = pid
    this.child.stdin = new PassThrough()
    this.child.stdout = new PassThrough()
    this.child.stderr = new PassThrough()
    this.child.stdin.on('data', (chunk: Buffer) => this.onData(chunk.toString('utf8')))
  }

  get supervisor(): ProcessSupervisor {
    const spawn: SpawnFn = (command, args, options) => {
      this.spawned.push({
        command,
        args,
        cwd: String(options.cwd),
        env: options.env as Record<string, string>
      })
      return this.child as unknown as ChildLike
    }
    return new ProcessSupervisor({
      spawn,
      kill: (_pid, signal) => {
        this.signals.push(signal)
        this.onSignal?.(signal)
        if (this.exitOn.has(signal)) this.exit(null, signal)
      }
    })
  }

  private onData(text: string): void {
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) {
      if (line.trim() === '') continue
      const msg = JSON.parse(line) as Msg
      this.received.push(msg)
      this.handle(msg)
    }
  }

  private handle(msg: Msg): void {
    const method = msg['method']
    if (typeof method !== 'string' || msg['id'] === undefined) return
    const custom = this.handlers[method]
    if (custom) return custom(msg, this)
    switch (method) {
      case 'initialize':
        return this.result(msg, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }
        })
      case 'session/new':
        return this.result(msg, sessionNewResult('m1-agent-turn.jsonl'))
      case 'session/load':
        return this.result(msg, {})
      default:
        return this.result(msg, {})
    }
  }

  /** Sends one JSON-RPC message the way Cursor does (with the version field). */
  send(message: Msg): void {
    this.child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }

  result(request: Msg, result: unknown): void {
    this.send({ id: request['id'], result })
  }

  error(request: Msg, code: number, message: string, data?: unknown): void {
    this.send({ id: request['id'], error: { code, message, ...(data ? { data } : {}) } })
  }

  update(update: Msg): void {
    this.send({ method: 'session/update', params: { sessionId: 'session-1', update } })
  }

  exit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.child.stdout.end()
    this.child.emit('exit', code, signal)
  }

  /** The requests the client sent with this method. */
  requests(method: string): Msg[] {
    return this.received.filter((m) => m['method'] === method)
  }

  /** The methods the client sent, in order (requests and notifications). */
  methods(): string[] {
    return this.received.flatMap((m) => (typeof m['method'] === 'string' ? [m['method']] : []))
  }

  /** The answers the client wrote to server requests (messages with a result and no method). */
  answers(): Msg[] {
    return this.received.filter((m) => m['method'] === undefined && 'result' in m)
  }
}

export async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}
