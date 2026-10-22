import { MCP_SERVER_NAME } from '../../bridge/types'
import {
  ProviderHistoryMissingError,
  ProviderUnavailableError,
  type AgentAdapter,
  type AgentHandle,
  type CursorStartRequest,
  type HandleCapabilities,
  type InterruptOutcome,
  type StartOptions
} from '../agent-adapter'
import type { AgentEvent } from '../agent-events'
import { isVersionBelow } from '../cli-resolver'
import { EventQueue } from '../event-queue'
import {
  buildAgentEnv,
  type ProcessSupervisor,
  type SupervisedProcess
} from '../process-supervisor'
import { RpcError, type JsonRpcId, type RpcServerRequest } from '../rpc/json-rpc-peer'
import { MIN_CURSOR_VERSION } from '../../../shared/types/provider'
import { AcpClient, isAuthRequired, isInvalidParams } from './acp-client'
import {
  buildSessionParams,
  cursorGlobalArgs,
  cursorModeFor,
  finishCursorEnv,
  withDeclines,
  withInstructions
} from './cursor-config'
import { createCursorParser, type CursorParser } from './cursor-parser'
import {
  ACP_METHOD_NOT_FOUND,
  CURSOR_APPROVAL_WITHDRAWN,
  permissionParamsSchema,
  type CursorApprovalDecision,
  type CursorApprovalHandler,
  type CursorApprovalRequest,
  type CursorCommand,
  type CursorPermissionOption,
  type CursorToolCall,
  type JsonObject
} from './cursor-types'

/**
 * Runs one Cursor agent over `agent acp`: a long-lived process that serves one ACP session. A turn
 * is one `session/prompt` request that stays open until the stop reason; `session/update`
 * notifications stream in meanwhile (tech spec 2.3).
 */

/** One prompt at a time: later sends queue behind the turn. A prompt cannot be steered into a running turn. */
export const CURSOR_CAPABILITIES: HandleCapabilities = {
  interruptCancelsApprovals: true,
  queuesSendsWhileBusy: true,
  midTurnSteer: false
}

export interface CursorAdapterTimings {
  /** Wait for the turn to end after `session/cancel`. */
  interruptAckMs: number
  /** Wait after SIGINT. */
  sigintMs: number
  /** Wait after SIGTERM, then after SIGKILL. */
  termMs: number
  /** `stop()`: wait for a clean exit after cancel and stdin close, before SIGTERM. */
  stopGraceMs: number
  /** `stop()`: wait after SIGTERM before SIGKILL. */
  stopTermMs: number
  /** One handshake request (`initialize`, `authenticate`, `session/new`, ...). */
  requestMs: number
}

export const DEFAULT_CURSOR_TIMINGS: CursorAdapterTimings = {
  interruptAckMs: 3000,
  sigintMs: 3000,
  termMs: 2000,
  stopGraceMs: 2000,
  stopTermMs: 5000,
  requestMs: 30_000
}

export interface CursorAdapterDeps {
  supervisor: ProcessSupervisor
  /** `CliResolver.cursorBinary()`: asked at each start, and undefined when Cursor is not installed. */
  binary: () => string | undefined | Promise<string | undefined>
  /** Args placed before `acp` (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  env?: NodeJS.ProcessEnv
  now?: () => number
  timings?: Partial<CursorAdapterTimings>
  /**
   * The installed Cursor version (`2026.10.19-6bbf2c4`), from the provider status. ACP does not
   * report one. When it is known and below `minVersion`, `start()` refuses before spawning.
   */
  version?: () => string | undefined | Promise<string | undefined>
  /** The oldest Cursor `start()` accepts. */
  minVersion?: string
  /** Start Cursor with `--sandbox enabled`; defaults to `CURSOR_SANDBOX_ENABLED`. */
  sandbox?: boolean
}

/** The option an allow or reject maps to, by kind and never by id text. `allow_always` is never chosen. */
export function optionFor(
  options: readonly CursorPermissionOption[],
  decision: CursorApprovalDecision['decision']
): { optionId: string; allowed: boolean } | undefined {
  if (decision === 'cancel') return undefined
  if (decision === 'allow') {
    const allow = options.find((o) => o.kind === 'allow_once')
    // Nothing Arc may choose for an allow: refuse rather than grant "always".
    if (allow) return { optionId: allow.optionId, allowed: true }
  }
  const reject = options.find((o) => o.kind === 'reject_once')
  return reject ? { optionId: reject.optionId, allowed: false } : undefined
}

export class CursorAdapter implements AgentAdapter {
  readonly provider = 'cursor' as const
  private readonly timings: CursorAdapterTimings

  constructor(private readonly deps: CursorAdapterDeps) {
    this.timings = { ...DEFAULT_CURSOR_TIMINGS, ...deps.timings }
  }

  async start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'cursor') {
      throw new Error(`The Cursor adapter cannot start a ${options.provider} agent.`)
    }
    const minVersion = this.deps.minVersion ?? MIN_CURSOR_VERSION
    const version = await this.deps.version?.()
    if (version !== undefined && isVersionBelow(version, minVersion)) {
      throw new ProviderUnavailableError(
        'cursor',
        'unsupported',
        `Cursor ${version} is older than the ${minVersion} Arc needs.`
      )
    }
    const binary = await this.deps.binary()
    if (binary === undefined) {
      throw new ProviderUnavailableError('cursor', 'missing', "Cursor isn't installed.")
    }
    const path = await this.deps.resolvePath()
    const baseEnv = this.deps.env ?? process.env
    const env = finishCursorEnv(buildAgentEnv(baseEnv, path, options.extraEnv), options)
    const proc = this.deps.supervisor.spawn({
      command: binary,
      args: [...(this.deps.binaryArgs ?? []), ...cursorGlobalArgs(this.deps.sandbox), 'acp'],
      cwd: options.cwd,
      env,
      agentId: options.agentId
    })
    const handle = new CursorHandle(
      options.agentId,
      proc,
      this.timings,
      this.deps.now ?? Date.now,
      options.cursor.approvals,
      options.instructions,
      options.cursor.onUnasked
    )
    try {
      await handle.handshake(options)
    } catch (error: unknown) {
      const spawnError = await handle.spawnFailure()
      await handle.stop()
      if (spawnError?.code === 'ENOENT') {
        throw new ProviderUnavailableError('cursor', 'missing', spawnError.message)
      }
      if (isAuthRequired(error)) {
        throw new ProviderUnavailableError('cursor', 'signed_out', "Cursor isn't signed in.")
      }
      if (options.resume && error instanceof RpcError && error.method === 'session/load') {
        // An expired or unknown session answers -32602 "not found" (spike N4): the caller starts fresh.
        if (isInvalidParams(error)) {
          throw new ProviderHistoryMissingError('cursor', options.resume.threadId, error.message)
        }
      }
      throw error
    }
    return handle
  }

  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle> {
    return this.start(options)
  }
}

type TurnWait = 'turn' | 'exit' | 'timeout'

export class CursorHandle implements AgentHandle {
  readonly provider = 'cursor' as const
  readonly capabilities = CURSOR_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  private readonly queue = new EventQueue<AgentEvent>()
  private readonly client: AcpClient
  private readonly parser: CursorParser
  private sessionId = ''
  /** The model the session runs, as far as Arc knows. */
  private currentModel = ''
  /** Set by `setModel`; applied with `session/set_model` before the next prompt. */
  private pendingModel: string | undefined
  /** Arc's instructions, put in front of the first prompt of this start or resume. */
  private pendingInstructions: string | undefined
  /** True while a prompt is being prepared or is open. */
  private busy = false
  /** The prompt of this turn has been sent; a `session/cancel` before that would be lost. */
  private promptSent = false
  private cancelBeforePrompt = false
  private readonly queuedSends: string[] = []
  /** Reasons for the requests Arc rejected since the last prompt; sent in front of the next one. */
  private pendingDeclines: string[] = []
  /** `session/load` replays the history as updates; they are dropped until the load answers. */
  private replaying = false
  private exitSeen = false
  private readonly waiters = new Set<(result: 'turn' | 'exit') => void>()
  /** Permission requests Arc has not answered yet. */
  private readonly approvalAborts = new Map<JsonRpcId, AbortController>()
  private spawnError: NodeJS.ErrnoException | undefined
  private readonly exitedSettled: Promise<void>

  constructor(
    readonly agentId: string,
    private readonly proc: SupervisedProcess,
    private readonly timings: CursorAdapterTimings,
    private readonly now: () => number,
    private readonly approvals: CursorApprovalHandler | undefined,
    instructions: string | undefined,
    onUnasked?: (call: CursorToolCall) => void
  ) {
    this.events = this.queue
    this.pendingInstructions = instructions
    this.parser = createCursorParser({
      agentId,
      now,
      ...(onUnasked ? { onUnasked } : {})
    })
    this.client = new AcpClient(proc, timings.requestMs)
    this.client.onNotification((method, params) => this.onNotification(method, params))
    this.client.onServerRequest((request) => this.onServerRequest(request))
    this.client.onInvalid((line) => this.emit({ type: 'unknown', agentId, ts: now(), raw: line }))
    proc.onLine((line) => this.client.handleLine(line))
    proc.onStderr((text) => this.emit({ type: 'stderr', agentId, ts: now(), text }))
    proc.onOverflow((bytes) =>
      this.emit({
        type: 'error',
        agentId,
        ts: now(),
        kind: 'parse',
        message: `Dropped an output line of ${bytes} bytes (limit exceeded).`
      })
    )
    this.exitedSettled = proc.exited.then((info) => {
      this.spawnError = info.spawnError
      if (info.spawnError) {
        const notInstalled = info.spawnError.code === 'ENOENT'
        this.emit({
          type: 'error',
          agentId,
          ts: now(),
          kind: notInstalled ? 'not-installed' : 'unknown',
          message: info.spawnError.message
        })
      }
      this.exitSeen = true
      this.emit({
        type: 'exit',
        agentId,
        ts: now(),
        code: info.code,
        signal: info.signal,
        expected: info.expected,
        stderrTail: info.stderrTail
      })
      this.queue.close()
      this.abortApprovals()
      this.client.close()
      for (const w of this.waiters) w('exit')
      this.waiters.clear()
    })
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  /** The error the process failed to spawn with, if it did. Waits briefly for the exit to be seen. */
  async spawnFailure(): Promise<NodeJS.ErrnoException | undefined> {
    await Promise.race([this.exitedSettled, new Promise((r) => setTimeout(r, 250))])
    return this.spawnError
  }

  /** The commands of the last `available_commands_update`, for the command probe. */
  availableCommands(): CursorCommand[] {
    return this.parser.availableCommands()
  }

  private emit(event: AgentEvent): void {
    this.queue.push(event)
  }

  private emitAll(events: readonly AgentEvent[]): void {
    for (const event of events) this.emit(event)
  }

  // ---- handshake -------------------------------------------------------------------------

  /**
   * `initialize`, `authenticate`, then `session/new` or `session/load`, then the mode and model,
   * then the `session` event. A -32000 anywhere surfaces as an RpcError the adapter maps to signed out.
   */
  async handshake(options: CursorStartRequest): Promise<void> {
    await this.client.initialize()
    await this.client.authenticate()

    const params = buildSessionParams(options)
    let reply: Awaited<ReturnType<AcpClient['newSession']>> | undefined
    if (options.resume) {
      this.sessionId = options.resume.threadId
      this.replaying = true
      try {
        await this.client.loadSession(this.sessionId, params)
      } finally {
        this.replaying = false
      }
    } else {
      reply = await this.client.newSession(params)
      this.sessionId = reply.sessionId
    }

    const mode = cursorModeFor(options.access)
    if (reply?.modes?.currentModeId !== mode) await this.client.setMode(this.sessionId, mode)
    this.currentModel = reply?.models?.currentModelId ?? ''
    if (options.model !== '' && options.model !== this.currentModel) {
      await this.client.setModel(this.sessionId, options.model)
      this.currentModel = options.model
    }

    this.emit({
      type: 'session',
      agentId: this.agentId,
      ts: this.now(),
      provider: 'cursor',
      providerSessionId: this.sessionId,
      model: this.currentModel,
      permissionMode: mode,
      mcpServers: options.bridge ? [{ name: MCP_SERVER_NAME, status: 'configured' }] : []
    })
  }

  // ---- notifications ---------------------------------------------------------------------

  private onNotification(method: string, params: JsonObject): void {
    if (this.replaying) {
      // The replayed history is not new output. The command list is not history, so it is kept.
      const update = params['update']
      const kind =
        typeof update === 'object' && update !== null
          ? (update as Record<string, unknown>)['sessionUpdate']
          : undefined
      if (method !== 'session/update' || kind !== 'available_commands_update') return
    }
    this.emitAll(this.parser.parse(method, params))
  }

  // ---- turns -----------------------------------------------------------------------------

  send(text: string): Promise<boolean> {
    if (this.exitSeen) return Promise.resolve(false)
    if (this.busy) this.queuedSends.push(text)
    else this.startTurn(text)
    return Promise.resolve(true)
  }

  discardQueuedSends(): string[] {
    return this.queuedSends.splice(0)
  }

  /** A Cursor model change takes effect from the next prompt (`session/set_model`), with no restart. */
  setModel(model: string): void {
    this.pendingModel = model
  }

  private startTurn(text: string): void {
    this.busy = true
    this.promptSent = false
    this.cancelBeforePrompt = false
    void this.runTurn(text)
  }

  private async runTurn(text: string): Promise<void> {
    this.emitAll(this.parser.beginTurn())
    try {
      await this.applyPendingModel()
      if (this.cancelBeforePrompt) {
        this.emitAll(this.parser.endTurn({ stopReason: 'cancelled' }))
        return
      }
      const body = withInstructions(
        this.pendingInstructions,
        withDeclines(this.pendingDeclines.splice(0), text)
      )
      this.pendingInstructions = undefined
      this.promptSent = true
      this.emitAll(this.parser.endTurn(await this.client.prompt(this.sessionId, body)))
    } catch (error: unknown) {
      // The process ended mid-turn: the `exit` event tells it, and no result is owed.
      if (!this.exitSeen) {
        const message = error instanceof Error ? error.message : String(error)
        this.emitAll(this.parser.endTurn({ error: message }))
      }
    } finally {
      this.busy = false
      this.promptSent = false
      // A turn that ends takes its unanswered permission requests with it.
      this.cancelPendingApprovals()
      for (const w of this.waiters) w('turn')
      this.waiters.clear()
      this.drain()
    }
  }

  /** Applies the model `setModel` asked for. A refusal (-32602 for an unknown id) is reported and the turn runs on the old model. */
  private async applyPendingModel(): Promise<void> {
    const model = this.pendingModel
    this.pendingModel = undefined
    if (model === undefined || model === this.currentModel) return
    try {
      await this.client.setModel(this.sessionId, model)
      this.currentModel = model
    } catch (error: unknown) {
      if (this.exitSeen) return
      this.emit({
        type: 'error',
        agentId: this.agentId,
        ts: this.now(),
        kind: 'api',
        message: `Cursor did not accept the model ${model}: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  /** Starts the next queued send, one at a time, so each send yields its own `turn-result`. */
  private drain(): void {
    if (this.exitSeen || this.busy) return
    const next = this.queuedSends.shift()
    if (next !== undefined) this.startTurn(next)
  }

  private waitForTurnEnd(ms: number): Promise<TurnWait> {
    if (this.exitSeen) return Promise.resolve('exit')
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(done)
        resolve('timeout')
      }, ms)
      const done = (result: 'turn' | 'exit'): void => {
        clearTimeout(timer)
        resolve(result)
      }
      this.waiters.add(done)
    })
  }

  /**
   * `session/cancel` (which also answers the pending permission requests `cancelled`), then SIGINT
   * after `interruptAckMs`, then SIGTERM and SIGKILL, as the Codex handle does.
   */
  async interrupt(): Promise<InterruptOutcome> {
    if (this.exitSeen || !this.busy) return 'idle'
    const ended = this.waitForTurnEnd(this.timings.interruptAckMs)
    if (this.promptSent) this.client.cancel(this.sessionId)
    else this.cancelBeforePrompt = true // the prompt is not out yet; the turn ends without sending it
    this.cancelPendingApprovals()
    if ((await ended) === 'turn') return 'acked'

    this.proc.kill('SIGINT')
    if ((await this.waitForTurnEnd(this.timings.sigintMs)) === 'turn') return 'sigint'

    await this.proc.killLadder([
      { signal: 'SIGTERM', waitMs: this.timings.termMs },
      { signal: 'SIGKILL', waitMs: this.timings.termMs }
    ])
    return 'killed'
  }

  /** Cancels the turn, closes stdin, waits briefly for a clean exit, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    if (this.exitSeen) return
    this.queuedSends.length = 0
    if (this.busy && this.promptSent) this.client.cancel(this.sessionId)
    this.cancelPendingApprovals()
    this.proc.expectExit()
    this.proc.endStdin()
    let timer: NodeJS.Timeout | undefined
    const exited = await Promise.race([
      this.proc.exited,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.timings.stopGraceMs)
      })
    ])
    clearTimeout(timer)
    if (exited) return
    await this.proc.killLadder([
      { signal: 'SIGTERM', waitMs: this.timings.stopTermMs },
      { signal: 'SIGKILL', waitMs: this.timings.stopTermMs }
    ])
  }

  // ---- server requests -------------------------------------------------------------------

  /** Aborts every handler without answering: the process is gone, so there is nobody to answer. */
  private abortApprovals(): void {
    for (const controller of this.approvalAborts.values()) controller.abort()
    this.approvalAborts.clear()
  }

  /** Withdraws every request Arc has not answered, answering each one `cancelled`. */
  private cancelPendingApprovals(): void {
    for (const [id, controller] of [...this.approvalAborts]) {
      this.approvalAborts.delete(id)
      controller.abort(CURSOR_APPROVAL_WITHDRAWN)
      this.client.answerPermission(id, undefined)
    }
  }

  private onServerRequest(request: RpcServerRequest): void {
    if (request.method === 'session/request_permission') {
      void this.approve(request)
      return
    }
    // `fs/*` and `terminal/*` are not advertised, so Cursor should never send them.
    this.client.rejectRequest(
      request.id,
      ACP_METHOD_NOT_FOUND,
      `Arc does not handle ${request.method}.`
    )
  }

  private async approve(request: RpcServerRequest): Promise<void> {
    const parsed = permissionParamsSchema.safeParse(request.params)
    if (!parsed.success || this.replaying) {
      this.client.answerPermission(request.id, undefined)
      return
    }
    const { toolCall, options } = parsed.data
    this.parser.markAsked(toolCall.toolCallId)
    const tool = this.parser.toolCall(toolCall.toolCallId)
    const approval: CursorApprovalRequest = {
      agentId: this.agentId,
      sessionId: this.sessionId,
      requestId: request.id,
      toolCallId: toolCall.toolCallId,
      title: toolCall.title ?? '',
      kind: toolCall.kind ?? 'other',
      options,
      raw: request.params,
      ...(tool ? { tool } : {})
    }
    const approvalId = String(request.id)
    const summary = approval.title
    const controller = new AbortController()
    this.approvalAborts.set(request.id, controller)
    this.emit({
      type: 'approval',
      agentId: this.agentId,
      ts: this.now(),
      approvalId,
      state: 'requested',
      summary
    })

    let decision: CursorApprovalDecision = { decision: 'reject' }
    if (this.approvals) {
      try {
        decision = await this.approvals.handle(approval, controller.signal)
      } catch {
        decision = { decision: 'reject' } // a handler that fails refuses
      }
    }
    const resolved = (state: 'allow' | 'deny' | 'cancelled'): void =>
      this.emit({
        type: 'approval',
        agentId: this.agentId,
        ts: this.now(),
        approvalId,
        state: 'resolved',
        summary,
        decision: state
      })
    if (!this.approvalAborts.has(request.id) || controller.signal.aborted) {
      // Withdrawn (an interrupt answered it `cancelled` already) or the process ended.
      resolved('cancelled')
      return
    }
    this.approvalAborts.delete(request.id)
    const chosen = optionFor(options, decision.decision)
    this.client.answerPermission(request.id, chosen?.optionId)
    if (decision.decision === 'reject' && chosen !== undefined && !chosen.allowed) {
      this.pendingDeclines.push(decision.message ?? `Arc declined ${summary || 'your request'}.`)
    }
    resolved(chosen === undefined ? 'cancelled' : chosen.allowed ? 'allow' : 'deny')
  }
}
