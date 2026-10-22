import type {
  AgentAdapter,
  AgentHandle,
  ClaudeStartRequest,
  HandleCapabilities,
  InterruptOutcome,
  McpServerTools,
  StartOptions
} from './agent-adapter'
import type { AgentEvent } from './agent-events'
import { createClaudeParser } from './claude-parser'
import { EventQueue } from './event-queue'
import { parseClaudeMcpStatus } from './mcp-status'
import { buildAgentEnv, type ProcessSupervisor, type SupervisedProcess } from './process-supervisor'
import { bridgeToolNamer } from './tool-namer'

/**
 * `--setting-sources project` keeps the user's permission rules, env and other settings out of the
 * agent (S0 item 7) and loads only the project's `.claude/settings.json`. The user's hooks and MCP
 * servers come in through generated files instead (`--settings`, `--mcp-config`; spec 007 section 2.6).
 */
const SETTING_SOURCES = 'project'

/** Read-only: files, search, and web pages (the group's Links). Nothing here changes anything. */
export const BRAIN_BASE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']
/** The brain never edits files itself; its shell goes through the permission prompt tool (read-only commands pass, the rest ask the user). */
export const BRAIN_DISALLOWED_TOOLS = 'Edit Write NotebookEdit AskUserQuestion'
export const PERMISSION_PROMPT_TOOL = 'mcp__arc__request_permission'

/**
 * What a worker may use without asking. Edits are not listed: `acceptEdits` accepts them inside its
 * working directories, and an edit anywhere else (or a Bash command) reaches the permission tool,
 * which classifies it (tech spec 2.3 and 2.6).
 */
export const WORKER_BASE_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob']

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'] as const

/** `--allowedTools` for the brain: the read-only tools (files, search, web), ToolSearch (MCP tools are deferred) and the exact bridge tools. */
export function brainAllowedTools(mcpTools: readonly string[] = []): string {
  const tools = [...BRAIN_BASE_TOOLS, ...(mcpTools.length > 0 ? ['ToolSearch', ...mcpTools] : [])]
  return tools.join(' ')
}

/** `Edit(//abs/dir/**)` style deny rules: a leading `//` means an absolute path in permission rules. */
export function denyEditRules(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => EDIT_TOOLS.map((tool) => `${tool}(/${dir}/**)`))
}

/** Claude's CLI queues a send while a turn runs, cannot take a steer, and keeps a pending permission prompt through an interrupt. */
export const CLAUDE_CAPABILITIES: HandleCapabilities = {
  interruptCancelsApprovals: false,
  queuesSendsWhileBusy: true,
  midTurnSteer: false
}

/** Builds the argv (without the binary) for one agent. See tech spec section 2.3. */
export function buildClaudeArgs(options: ClaudeStartRequest): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--model',
    options.model,
    '--setting-sources',
    SETTING_SOURCES
  ]
  // Only the user's hooks: `--setting-sources project` stays, so no permission rule or env of theirs loads.
  if (options.claude.hooksSettingsPath) args.push('--settings', options.claude.hooksSettingsPath)
  for (const dir of options.addDirs ?? []) args.push('--add-dir', dir)
  if (options.instructions) args.push('--append-system-prompt', options.instructions)
  if (options.resume) args.push('--resume', options.resume.threadId)
  const { claude } = options
  if (claude.mcpConfigPath) args.push(`--mcp-config=${claude.mcpConfigPath}`, '--strict-mcp-config')
  if (claude.pluginViewDir) args.push('--plugin-dir', claude.pluginViewDir)

  const namer = bridgeToolNamer('claude')
  const mcpTools = (options.bridgeTools ?? []).map((tool) => namer.name(tool))
  if (options.role === 'brain') {
    // Default permission mode. Bash is not allowed outright: it reaches the permission prompt tool,
    // which lets read-only commands through and asks the user for the rest. Without that tool,
    // anything not allowed is refused in -p mode.
    if (claude.permissionPromptTool) {
      args.push('--permission-prompt-tool', claude.permissionPromptTool)
    }
    args.push(
      '--allowedTools',
      brainAllowedTools(mcpTools),
      '--disallowedTools',
      BRAIN_DISALLOWED_TOOLS
    )
  } else {
    args.push('--permission-mode', 'acceptEdits')
    if (claude.permissionPromptTool) {
      args.push('--permission-prompt-tool', claude.permissionPromptTool)
    }
    // One argument per rule: the rules contain spaces (`Bash(git add:*)`).
    args.push(
      '--allowedTools',
      ...WORKER_BASE_TOOLS,
      ...(mcpTools.length > 0 ? ['ToolSearch', ...mcpTools] : [])
    )
    const deny = denyEditRules(options.readOnlyDirs ?? [])
    if (deny.length > 0) args.push('--disallowedTools', ...deny)
  }
  return args
}

export interface ClaudeAdapterTimings {
  /** Wait for the turn to end after the stream-json interrupt. */
  interruptAckMs: number
  /** Wait after SIGINT. */
  sigintMs: number
  /** Wait after SIGTERM, then after SIGKILL. */
  termMs: number
  /** `stop()`: wait for a clean exit after interrupt and stdin close, before SIGTERM. */
  stopGraceMs: number
  /** `stop()`: wait after SIGTERM before SIGKILL. */
  stopTermMs: number
  /** `mcpTools()`: wait for the CLI's `mcp_status` answer. */
  mcpStatusMs: number
}

export const DEFAULT_TIMINGS: ClaudeAdapterTimings = {
  interruptAckMs: 3000,
  sigintMs: 3000,
  termMs: 2000,
  stopGraceMs: 5000,
  stopTermMs: 5000,
  mcpStatusMs: 10_000
}

export interface ClaudeAdapterDeps {
  supervisor: ProcessSupervisor
  /** `CliResolver.claudeBinary()`. */
  binary: string
  /** Args placed before the CLI's own (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  env?: NodeJS.ProcessEnv
  now?: () => number
  timings?: Partial<ClaudeAdapterTimings>
}

type TurnWait = 'turn' | 'exit' | 'timeout'

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const
  private readonly timings: ClaudeAdapterTimings

  constructor(private readonly deps: ClaudeAdapterDeps) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings }
  }

  async start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'claude') {
      throw new Error(`The Claude adapter cannot start a ${options.provider} agent.`)
    }
    const path = await this.deps.resolvePath()
    const env = buildAgentEnv(this.deps.env ?? process.env, path, options.extraEnv)
    // Last, like the Codex adapter: nothing in `extraEnv` changes who the agent is.
    env['ARC_AGENT'] = '1'
    env['ARC_AGENT_ROLE'] = options.role
    env['ARC_PROVIDER'] = 'claude'
    const proc = this.deps.supervisor.spawn({
      command: this.deps.binary,
      args: [...(this.deps.binaryArgs ?? []), ...buildClaudeArgs(options)],
      cwd: options.cwd,
      env,
      agentId: options.agentId
    })
    return new ClaudeHandle(options.agentId, proc, this.timings, this.deps.now ?? Date.now)
  }

  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle> {
    return this.start(options)
  }
}

class ClaudeHandle implements AgentHandle {
  readonly provider = 'claude' as const
  readonly capabilities = CLAUDE_CAPABILITIES
  readonly events: AsyncIterable<AgentEvent>
  private readonly queue = new EventQueue<AgentEvent>()
  private turnActive = false
  private exitSeen = false
  private requestCounter = 0
  private readonly waiters = new Set<(result: 'turn' | 'exit') => void>()
  /** `mcp_status` requests waiting for the CLI's answer, by request id. */
  private readonly statusWaiters = new Map<
    string,
    {
      resolve: (value: McpServerTools[]) => void
      reject: (error: Error) => void
      timer: NodeJS.Timeout
    }
  >()

  constructor(
    readonly agentId: string,
    private readonly proc: SupervisedProcess,
    private readonly timings: ClaudeAdapterTimings,
    private readonly now: () => number
  ) {
    this.events = this.queue
    const parser = createClaudeParser({ agentId, now })
    proc.onLine((line) => {
      // The answer to Arc's own `mcp_status` is not a turn event; the parser never sees it.
      if (this.statusWaiters.size > 0 && this.settleStatus(line)) return
      for (const event of parser.parse(line)) this.emit(event)
    })
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
    void proc.exited.then((info) => {
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
      for (const w of this.waiters) w('exit')
      this.waiters.clear()
      this.failStatusWaiters(new Error('The agent has exited.'))
    })
  }

  /**
   * Asks the CLI which MCP servers it runs and what their tools are annotated as (`control_request`
   * `mcp_status`, spike S8). Rejects on a timeout, an error answer or when the process is gone.
   */
  mcpTools(): Promise<McpServerTools[]> {
    if (this.exitSeen) return Promise.reject(new Error('The agent has exited.'))
    this.requestCounter += 1
    const id = `arc_mcp_${this.requestCounter}`
    return new Promise<McpServerTools[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.statusWaiters.delete(id)
        reject(new Error('The agent did not report its MCP servers in time.'))
      }, this.timings.mcpStatusMs)
      this.statusWaiters.set(id, { resolve, reject, timer })
      const written = this.proc.writeLine(
        JSON.stringify({
          type: 'control_request',
          request_id: id,
          request: { subtype: 'mcp_status' }
        })
      )
      if (!written) this.failStatusWaiters(new Error('The agent is not reading its input.'))
    })
  }

  /** True when `line` was the answer to one of Arc's `mcp_status` requests (and settles it). */
  private settleStatus(line: string): boolean {
    if (!line.includes('"arc_mcp_')) return false
    let parsed: { type?: unknown; response?: Record<string, unknown> } | null
    try {
      parsed = JSON.parse(line) as typeof parsed
    } catch {
      return false
    }
    const response = parsed?.response
    const id = response?.['request_id']
    if (parsed?.type !== 'control_response' || response === undefined || typeof id !== 'string') {
      return false
    }
    const waiter = this.statusWaiters.get(id)
    if (!waiter) return false
    this.statusWaiters.delete(id)
    clearTimeout(waiter.timer)
    if (response['subtype'] === 'success') {
      waiter.resolve(parseClaudeMcpStatus(response['response']))
    } else {
      waiter.reject(new Error('The agent could not report its MCP servers.'))
    }
    return true
  }

  private failStatusWaiters(error: Error): void {
    for (const waiter of this.statusWaiters.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.statusWaiters.clear()
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  private emit(event: AgentEvent): void {
    if (event.type === 'turn-result') {
      this.turnActive = false
      for (const w of this.waiters) w('turn')
      this.waiters.clear()
    }
    this.queue.push(event)
  }

  send(text: string): Promise<boolean> {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] }
    })
    const written = this.proc.writeLine(line)
    if (written) this.turnActive = true
    return Promise.resolve(written)
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

  private writeInterrupt(): boolean {
    this.requestCounter += 1
    return this.proc.writeLine(
      JSON.stringify({
        type: 'control_request',
        request_id: `arc_int_${this.requestCounter}`,
        request: { subtype: 'interrupt' }
      })
    )
  }

  /** Stream-json interrupt, then SIGINT after `interruptAckMs`, then SIGTERM and SIGKILL. */
  async interrupt(): Promise<InterruptOutcome> {
    if (!this.turnActive || this.exitSeen) return 'idle'
    this.writeInterrupt()
    if ((await this.waitForTurnEnd(this.timings.interruptAckMs)) === 'turn') return 'acked'

    this.proc.kill('SIGINT')
    const afterSigint = await this.waitForTurnEnd(this.timings.sigintMs)
    if (afterSigint === 'turn') return 'sigint'

    await this.proc.killLadder([
      { signal: 'SIGTERM', waitMs: this.timings.termMs },
      { signal: 'SIGKILL', waitMs: this.timings.termMs }
    ])
    return 'killed'
  }

  /** Interrupt, close stdin, wait for a clean exit, then SIGTERM, then SIGKILL. */
  async stop(): Promise<void> {
    if (this.exitSeen) return
    if (this.turnActive) this.writeInterrupt()
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
}
