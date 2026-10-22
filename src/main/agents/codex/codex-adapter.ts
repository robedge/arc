import { MCP_SERVER_NAME } from '../../bridge/types'
import {
  ProviderHistoryMissingError,
  ProviderUnavailableError,
  type AgentAdapter,
  type AgentHandle,
  type CodexStartRequest,
  type HandleCapabilities,
  type InterruptOutcome,
  type McpServerTools,
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
import { MIN_CODEX_VERSION } from '../../../shared/types/provider'
import {
  buildThreadResumeParams,
  buildThreadStartParams,
  finishCodexEnv,
  workingCopiesOf
} from './codex-config'
import { writeArcRules } from './codex-rules'
import { codexMcpNextCursor, parseCodexMcpStatus } from '../mcp-status'
import { unwrapShell } from './codex-normalize'
import { createCodexParser, type CodexParser } from './codex-parser'
import { CodexRpc, RpcError, type RpcServerRequest } from './codex-rpc'
import {
  accountResponseSchema,
  approvalParamsSchema,
  elicitationParamsSchema,
  initializeResponseSchema,
  mcpStartupSchema,
  threadResponseSchema,
  turnNotificationSchema,
  turnStartResponseSchema,
  APPROVAL_WITHDRAWN,
  type ApprovalHandler,
  type CodexApprovalDecision,
  type CodexApprovalKind,
  type CodexApprovalRequest,
  type CodexInput,
  type CodexItem,
  type JsonObject,
  type JsonRpcId
} from './codex-types'

/** `mcpServerStatus/list` pages read for one `mcpTools()` call. */
const MCP_STATUS_MAX_PAGES = 10

/** Codex waits for a turn to end before it takes the next send; an interrupt ends the turn at once. */
export const CODEX_CAPABILITIES: HandleCapabilities = {
  interruptCancelsApprovals: true,
  queuesSendsWhileBusy: true,
  midTurnSteer: true
}

export interface CodexAdapterTimings {
  /** Wait for the turn to end after `turn/interrupt`. */
  interruptAckMs: number
  /** Wait after SIGINT. */
  sigintMs: number
  /** Wait after SIGTERM, then after SIGKILL. */
  termMs: number
  /** `stop()`: wait for a clean exit after interrupt and stdin close, before SIGTERM. */
  stopGraceMs: number
  /** `stop()`: wait after SIGTERM before SIGKILL. */
  stopTermMs: number
  /** One handshake request (`initialize`, `account/read`, `thread/start`, `turn/start`). */
  requestMs: number
  /** Wait for the required `arc` MCP server to report ready (its own startup timeout is 20 s). */
  mcpReadyMs: number
}

export const DEFAULT_CODEX_TIMINGS: CodexAdapterTimings = {
  interruptAckMs: 3000,
  sigintMs: 3000,
  termMs: 2000,
  stopGraceMs: 5000,
  stopTermMs: 5000,
  requestMs: 30_000,
  mcpReadyMs: 25_000
}

export interface CodexAdapterDeps {
  supervisor: ProcessSupervisor
  /** `CliResolver.codexBinary()`. */
  binary: string
  /** Args placed before `app-server` (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  env?: NodeJS.ProcessEnv
  now?: () => number
  timings?: Partial<CodexAdapterTimings>
  /** Arc's version, sent in `clientInfo`. */
  clientVersion?: string
  /** The oldest app-server `start()` accepts. */
  minVersion?: string
  /**
   * Runs for each working copy of a worker before every launch and relaunch. Defaults to writing
   * Arc's `arc.rules`; it throws when it cannot, and then the worker does not start.
   */
  prepareWorkingCopy?: (path: string) => void
}

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601

/** `thread/resume` for a thread Codex no longer has ("thread not found", "no rollout found for thread id ..."). */
const HISTORY_MISSING = /thread not found|no rollout found|rollout .*not found/i

/** The text of a queued send; a skill input counts as its text part. */
function textOf(input: string | CodexInput[]): string {
  if (typeof input === 'string') return input
  return input.map((part) => (part.type === 'text' ? part.text : `$${part.name}`)).join(' ')
}

function isHistoryMissing(error: unknown): error is RpcError {
  return (
    error instanceof RpcError &&
    error.method === 'thread/resume' &&
    HISTORY_MISSING.test(error.message)
  )
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const
  private readonly timings: CodexAdapterTimings

  constructor(private readonly deps: CodexAdapterDeps) {
    this.timings = { ...DEFAULT_CODEX_TIMINGS, ...deps.timings }
  }

  async start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'codex') {
      throw new Error(`The Codex adapter cannot start a ${options.provider} agent.`)
    }
    // A worker never starts without Arc's rules: the user's own Codex rules could otherwise skip its approvals.
    if (options.access === 'worker-write') {
      const prepare = this.deps.prepareWorkingCopy ?? writeArcRules
      for (const tree of workingCopiesOf(options)) prepare(tree)
    }
    const path = await this.deps.resolvePath()
    const baseEnv = this.deps.env ?? process.env
    const env = finishCodexEnv(buildAgentEnv(baseEnv, path, options.extraEnv), options, baseEnv)
    const proc = this.deps.supervisor.spawn({
      command: this.deps.binary,
      args: [...(this.deps.binaryArgs ?? []), 'app-server'],
      cwd: options.cwd,
      env,
      agentId: options.agentId
    })
    const handle = new CodexHandle(
      options.agentId,
      proc,
      this.timings,
      this.deps.now ?? Date.now,
      options.approvals
    )
    try {
      await handle.handshake(
        options,
        this.deps.clientVersion ?? '0',
        this.deps.minVersion ?? MIN_CODEX_VERSION
      )
    } catch (error: unknown) {
      const spawnError = await handle.spawnFailure()
      await handle.stop()
      if (spawnError?.code === 'ENOENT') {
        throw new ProviderUnavailableError('codex', 'missing', spawnError.message)
      }
      if (options.resume && isHistoryMissing(error)) {
        throw new ProviderHistoryMissingError('codex', options.resume.threadId, error.message)
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

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

class CodexHandle implements AgentHandle {
  readonly provider = 'codex' as const
  readonly capabilities = CODEX_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  private readonly queue = new EventQueue<AgentEvent>()
  private readonly rpc: CodexRpc
  private readonly parser: CodexParser
  private threadId = ''
  /** Set by `setModel`; sent with every `turn/start` from then on. */
  private modelOverride: string | undefined
  private activeTurnId: string | null = null
  /** The in-flight `turn/start`; `interrupt()` waits for it because the turn id is not known before. */
  private starting: Promise<void> | null = null
  /** Sends that arrived while a turn was active or starting, in order. */
  private readonly queuedSends: (string | CodexInput[])[] = []
  private readonly completedTurns = new Set<string>()
  private exitSeen = false
  private readonly waiters = new Set<(result: 'turn' | 'exit') => void>()
  private readonly approvalAborts = new Map<JsonRpcId, AbortController>()
  private readonly mcpStatus = new Map<string, { status: string; error?: string }>()
  private readonly mcpListeners = new Set<() => void>()
  private spawnError: NodeJS.ErrnoException | undefined
  private readonly exitedSettled: Promise<void>

  constructor(
    readonly agentId: string,
    private readonly proc: SupervisedProcess,
    private readonly timings: CodexAdapterTimings,
    private readonly now: () => number,
    private readonly approvals: ApprovalHandler | undefined
  ) {
    this.events = this.queue
    this.parser = createCodexParser({ agentId, now })
    this.rpc = new CodexRpc(proc, timings.requestMs)
    this.rpc.onNotification((method, params) => this.onNotification(method, params))
    this.rpc.onServerRequest((request) => this.onServerRequest(request))
    this.rpc.onInvalid((line) => this.emit({ type: 'unknown', agentId, ts: now(), raw: line }))
    proc.onLine((line) => this.rpc.handleLine(line))
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
      this.rpc.close()
      for (const w of this.waiters) w('exit')
      this.waiters.clear()
      for (const l of this.mcpListeners) l()
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

  private emit(event: AgentEvent): void {
    this.queue.push(event)
  }

  // ---- handshake -------------------------------------------------------------------------

  /**
   * `initialize`, the version and account checks, then `thread/start` or `thread/resume`, then the
   * wait for the required `arc` server. Throws `ProviderUnavailableError` for an old or signed-out Codex.
   */
  async handshake(
    options: CodexStartRequest,
    clientVersion: string,
    minVersion: string
  ): Promise<void> {
    const initialized = initializeResponseSchema.safeParse(
      await this.rpc.request('initialize', {
        clientInfo: { name: 'arc', title: 'Arc', version: clientVersion },
        capabilities: { experimentalApi: true }
      })
    )
    this.rpc.notify('initialized')
    const version = /\/(\d+\.\d+\.\d+)/.exec(
      initialized.success ? (initialized.data.userAgent ?? '') : ''
    )?.[1]
    if (version !== undefined && isVersionBelow(version, minVersion)) {
      throw new ProviderUnavailableError(
        'codex',
        'unsupported',
        `Codex ${version} is older than the ${minVersion} Arc needs.`
      )
    }

    const account = accountResponseSchema.safeParse(
      await this.rpc.request('account/read', { refreshToken: false })
    )
    if (
      account.success &&
      account.data.account == null &&
      account.data.requiresOpenaiAuth === true
    ) {
      throw new ProviderUnavailableError('codex', 'signed_out', "Codex isn't signed in.")
    }

    const resumeId = options.resume?.threadId
    const reply = threadResponseSchema.safeParse(
      resumeId
        ? await this.rpc.request('thread/resume', buildThreadResumeParams(options, resumeId))
        : await this.rpc.request('thread/start', buildThreadStartParams(options))
    )
    if (!reply.success)
      throw new Error('Codex answered the thread request with an unexpected shape.')
    this.threadId = reply.data.thread.id
    const model = reply.data.model ?? reply.data.thread.model ?? options.model

    if (options.bridge) await this.waitForMcp(MCP_SERVER_NAME)

    this.emit({
      type: 'session',
      agentId: this.agentId,
      ts: this.now(),
      provider: 'codex',
      providerSessionId: this.threadId,
      model,
      mcpServers: [...this.mcpStatus].map(([name, s]) => ({ name, status: s.status }))
    })
  }

  /** Waits until the named MCP server reports `ready`; rejects when it fails, the process ends or the wait runs out. */
  private waitForMcp(name: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`The ${name} MCP server did not start in time.`)),
        this.timings.mcpReadyMs
      )
      const check = (): void => {
        const state = this.mcpStatus.get(name)
        if (state?.status === 'ready') return finish()
        if (state?.status === 'failed' || state?.status === 'cancelled') {
          return finish(
            new Error(
              `The ${name} MCP server failed to start${state.error ? `: ${state.error}` : '.'}`
            )
          )
        }
        if (this.exitSeen) finish(new Error('Codex exited while starting.'))
      }
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.mcpListeners.delete(check)
        if (error) reject(error)
        else resolve()
      }
      this.mcpListeners.add(check)
      check()
    })
  }

  // ---- notifications ---------------------------------------------------------------------

  private onNotification(method: string, params: JsonObject): void {
    if (method === 'mcpServer/startupStatus/updated') {
      const parsed = mcpStartupSchema.safeParse(params)
      if (parsed.success) {
        const error = stringOf(params['error'])
        this.mcpStatus.set(parsed.data.name, {
          status: parsed.data.status,
          ...(error === '' ? {} : { error })
        })
        for (const l of [...this.mcpListeners]) l()
      }
    } else if (method === 'turn/started') {
      const parsed = turnNotificationSchema.safeParse(params)
      if (parsed.success) this.activeTurnId = parsed.data.turn.id
    } else if (method === 'serverRequest/resolved') {
      const id = params['requestId']
      if (typeof id === 'number' || typeof id === 'string') {
        this.approvalAborts.get(id)?.abort(APPROVAL_WITHDRAWN)
      }
    }

    let completed: { id: string; status: string } | undefined
    if (method === 'turn/completed') {
      const parsed = turnNotificationSchema.safeParse(params)
      if (parsed.success)
        completed = { id: parsed.data.turn.id, status: parsed.data.turn.status ?? '' }
    }

    for (const event of this.parser.parse(method, params)) this.emit(event)
    if (completed) this.onTurnCompleted(completed)
  }

  private onTurnCompleted(turn: { id: string; status: string }): void {
    this.completedTurns.add(turn.id)
    if (this.activeTurnId === turn.id || this.activeTurnId === null) this.activeTurnId = null
    // Codex withdraws the pending approvals of an interrupted turn (spike S6); its `serverRequest/resolved`
    // arrives after `turn/completed`, so the handlers are cancelled here and not on that notification.
    if (turn.status === 'interrupted') this.abortApprovals(APPROVAL_WITHDRAWN)
    for (const w of this.waiters) w('turn')
    this.waiters.clear()
    this.drain()
  }

  // ---- turns -----------------------------------------------------------------------------

  send(text: string): Promise<boolean> {
    return this.sendInput(text)
  }

  /**
   * Starts a turn with `input`: text, or a skill input list (`[{type:'skill',name,path},{type:'text',text}]`
   * for a Codex skill). Queued behind a running turn like any other send.
   */
  sendInput(input: string | CodexInput[]): Promise<boolean> {
    if (this.exitSeen) return Promise.resolve(false)
    if (this.activeTurnId !== null || this.starting !== null) {
      this.queuedSends.push(input)
    } else {
      this.startTurn(input)
    }
    return Promise.resolve(true)
  }

  /** Starts the next queued send, one at a time, so each send yields its own `turn-result`. */
  private drain(): void {
    if (this.exitSeen || this.activeTurnId !== null || this.starting !== null) return
    const next = this.queuedSends.shift()
    if (next !== undefined) this.startTurn(next)
  }

  private startTurn(input: string | CodexInput[]): void {
    const run = this.runStart(input)
    this.starting = run
    void run.then(() => {
      if (this.starting === run) this.starting = null
      this.drain()
    })
  }

  private async runStart(input: string | CodexInput[]): Promise<void> {
    try {
      const reply = turnStartResponseSchema.parse(
        await this.rpc.request('turn/start', {
          threadId: this.threadId,
          input: typeof input === 'string' ? [{ type: 'text', text: input }] : input,
          ...(this.modelOverride !== undefined ? { model: this.modelOverride } : {})
        })
      )
      const id = reply.turn.id
      if (!this.completedTurns.has(id) && this.activeTurnId === null) this.activeTurnId = id
    } catch (error: unknown) {
      if (this.exitSeen) return
      this.emit({
        type: 'error',
        agentId: this.agentId,
        ts: this.now(),
        kind: 'api',
        message: error instanceof Error ? error.message : String(error)
      })
      // The send never became a turn; its consumer still gets the one result it is waiting for.
      this.emit({
        type: 'turn-result',
        agentId: this.agentId,
        ts: this.now(),
        ok: false,
        interrupted: false,
        durationMs: 0,
        status: 'failed'
      })
    }
  }

  discardQueuedSends(): string[] {
    return this.queuedSends.splice(0).map(textOf)
  }

  /** A Codex model change takes effect from the next turn: `turn/start` carries the model (tech spec 2.1). */
  setModel(model: string): void {
    this.modelOverride = model
  }

  /**
   * The thread's MCP servers and the annotations of their tools (`mcpServerStatus/list`, tools only).
   * Rejects when Codex does not answer.
   */
  async mcpTools(): Promise<McpServerTools[]> {
    if (this.exitSeen) throw new Error('The agent has exited.')
    const out: McpServerTools[] = []
    let cursor: string | undefined
    for (let page = 0; page < MCP_STATUS_MAX_PAGES; page += 1) {
      const reply = await this.rpc.request('mcpServerStatus/list', {
        threadId: this.threadId,
        detail: 'toolsAndAuthOnly',
        ...(cursor === undefined ? {} : { cursor })
      })
      out.push(...parseCodexMcpStatus(reply))
      cursor = codexMcpNextCursor(reply)
      if (cursor === undefined) break
    }
    return out
  }

  /** Steers text into the turn that is running. False when no turn runs or Codex refuses. */
  async steer(text: string): Promise<boolean> {
    const expectedTurnId = this.activeTurnId
    if (expectedTurnId === null || this.exitSeen) return false
    try {
      await this.rpc.request('turn/steer', {
        threadId: this.threadId,
        expectedTurnId,
        input: [{ type: 'text', text }]
      })
      return true
    } catch {
      return false
    }
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
   * `turn/interrupt`, then SIGINT after `interruptAckMs`, then SIGTERM and SIGKILL. A turn that is
   * still starting is waited for first: its id is not known until `turn/start` answers.
   */
  async interrupt(): Promise<InterruptOutcome> {
    if (this.exitSeen) return 'idle'
    if (this.activeTurnId === null && this.starting === null) return 'idle'
    if (this.starting !== null) await this.starting
    const turnId = this.activeTurnId
    if (turnId === null || this.exitSeen) return 'idle'

    const ended = this.waitForTurnEnd(this.timings.interruptAckMs)
    this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId }).catch(() => undefined)
    if ((await ended) === 'turn') return 'acked'

    this.proc.kill('SIGINT')
    if ((await this.waitForTurnEnd(this.timings.sigintMs)) === 'turn') return 'sigint'

    await this.proc.killLadder([
      { signal: 'SIGTERM', waitMs: this.timings.termMs },
      { signal: 'SIGKILL', waitMs: this.timings.termMs }
    ])
    return 'killed'
  }

  /** Interrupt, close stdin, wait for a clean exit, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    if (this.exitSeen) return
    this.queuedSends.length = 0
    const turnId = this.activeTurnId
    if (turnId !== null) {
      this.rpc
        .request('turn/interrupt', { threadId: this.threadId, turnId }, 1000)
        .catch(() => undefined)
    }
    this.abortApprovals()
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

  /** `reason` tells the handler whether Codex withdrew the requests (`APPROVAL_WITHDRAWN`) or they were only lost. */
  private abortApprovals(reason?: string): void {
    for (const controller of this.approvalAborts.values()) controller.abort(reason)
    this.approvalAborts.clear()
  }

  private onServerRequest(request: RpcServerRequest): void {
    switch (request.method) {
      case 'item/commandExecution/requestApproval':
        void this.approve('command', request)
        return
      case 'item/fileChange/requestApproval':
        void this.approve('file-change', request)
        return
      case 'item/permissions/requestApproval':
        void this.approve('permissions', request)
        return
      case 'mcpServer/elicitation/request':
        void this.approve('mcp-elicitation', request)
        return
      case 'item/tool/requestUserInput': {
        // Unavailable outside Plan mode (spike S5); `ask_brain` is the only question path. Answer with nothing.
        const questions = Array.isArray(request.params['questions'])
          ? (request.params['questions'] as unknown[])
          : []
        this.emit({
          type: 'user-input-request',
          agentId: this.agentId,
          ts: this.now(),
          requestId: String(request.id),
          questions: questions.map((q) => {
            const record = (typeof q === 'object' && q !== null ? q : {}) as Record<string, unknown>
            const header = stringOf(record['header'])
            return { question: stringOf(record['question']), ...(header === '' ? {} : { header }) }
          })
        })
        this.rpc.respond(request.id, { answers: {} })
        return
      }
      default:
        this.rpc.respondError(
          request.id,
          METHOD_NOT_FOUND,
          `Arc does not handle ${request.method}.`
        )
    }
  }

  /** Builds the request the handler sees, and the line the approval shows as. */
  private describe(
    kind: CodexApprovalKind,
    request: RpcServerRequest
  ): { approval: CodexApprovalRequest; summary: string } | undefined {
    const params = request.params
    let item: CodexItem | undefined
    let summary: string
    if (kind === 'mcp-elicitation') {
      const parsed = elicitationParamsSchema.safeParse(params)
      const server = parsed.success ? stringOf(parsed.data.serverName) : ''
      // Only a tool approval is a request for a decision; other elicitations are not supported.
      if (!parsed.success || parsed.data._meta?.codex_approval_kind !== 'mcp_tool_call')
        return undefined
      item = this.parser.activeMcpCall(server)
      summary = item ? `${server}.${stringOf(item['tool'])}` : (parsed.data.message ?? server)
    } else {
      const parsed = approvalParamsSchema.safeParse(params)
      item = parsed.success && parsed.data.itemId ? this.parser.item(parsed.data.itemId) : undefined
      if (kind === 'command') summary = unwrapShell(stringOf(params['command']))
      else if (kind === 'file-change')
        summary = `file change${stringOf(params['reason']) ? `: ${stringOf(params['reason'])}` : ''}`
      else summary = stringOf(params['reason']) || 'extra permissions'
    }
    return {
      summary,
      approval: {
        kind,
        method: request.method,
        requestId: request.id,
        agentId: this.agentId,
        threadId: stringOf(params['threadId']) || this.threadId,
        turnId: stringOf(params['turnId']) || (this.activeTurnId ?? ''),
        raw: params,
        ...(item ? { item } : {})
      }
    }
  }

  private async approve(kind: CodexApprovalKind, request: RpcServerRequest): Promise<void> {
    const described = this.describe(kind, request)
    if (!described) {
      // An elicitation that is not a tool approval: Arc has no form to show, so it is cancelled.
      this.emit({
        type: 'unknown',
        agentId: this.agentId,
        ts: this.now(),
        raw: { method: request.method, cancelled: 'not a tool approval', params: request.params }
      })
      this.rpc.respond(request.id, { action: 'cancel', content: null })
      return
    }
    const { approval, summary } = described
    const approvalId = String(request.id)
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

    let decision: CodexApprovalDecision = { decision: 'decline' }
    if (this.approvals) {
      try {
        decision = await this.approvals.handle(approval, controller.signal)
      } catch {
        decision = { decision: 'decline' } // a handler that fails refuses
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
    const answer =
      decision.decision === 'accept' || decision.decision === 'cancel'
        ? decision.decision
        : 'decline'
    // The decline response has no text, and the model answers a decline at once: the reason is
    // steered into the turn first so its next step already has it (spike S6). Best effort.
    if (answer === 'decline' && decision.message && !controller.signal.aborted) {
      await this.steer(`[Arc] ${decision.message}`)
    }
    this.approvalAborts.delete(request.id)
    if (controller.signal.aborted) {
      // Codex withdrew the request (interrupt or exit); a late answer would be ignored anyway.
      resolved('cancelled')
      return
    }
    this.rpc.respond(request.id, wireAnswer(kind, answer, request.params))
    resolved(answer === 'accept' ? 'allow' : answer === 'cancel' ? 'cancelled' : 'deny')
  }
}

/**
 * The response line for a decision. Only `accept`, `decline` and `cancel` ever go out: never
 * `acceptForSession`, never an execpolicy amendment, never `scope: 'session'`.
 */
export function wireAnswer(
  kind: CodexApprovalKind,
  decision: 'accept' | 'decline' | 'cancel',
  params: JsonObject
): JsonObject {
  switch (kind) {
    case 'command':
    case 'file-change':
      return { decision }
    case 'mcp-elicitation':
      return { action: decision, content: null }
    case 'permissions':
      // The profile Codex asked for, for this turn only; a refusal grants nothing.
      return {
        permissions: decision === 'accept' ? (params['permissions'] ?? {}) : {},
        scope: 'turn'
      }
  }
}
