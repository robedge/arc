import { mkdir, writeFile } from 'node:fs/promises'
import type { AgentEvent, RateLimitWindow } from '../agents/agent-events'
import { createClaudeParser } from '../agents/claude-parser'
import { buildAgentEnv, type ProcessSupervisor } from '../agents/process-supervisor'
import type { ModelRef } from '../../shared/types/provider'
import type { PlanCheckUsage } from './usage-recorder'

/**
 * The Claude plan check on launch (spec 008, tech spec 2.5): one tiny request on the lightest Claude
 * model, so the plan meter has a value before any agent runs. Its `rate_limit_event` carries the
 * windows; its usage is recorded as a `plan_check` row with no session.
 */

export const PLAN_PROBE_TIMEOUT_MS = 30_000
const STOP_GRACE_MS = 1000
const KILL_STEP_MS = 1500

/** The flags of the check; every one exists in CLI 2.1.302. Nothing of the user's setup is loaded. */
export function buildPlanProbeArgs(model: string, settingsPath: string): string[] {
  return [
    '-p',
    '.',
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--tools',
    '',
    '--strict-mcp-config',
    '--disable-slash-commands',
    '--setting-sources',
    'project',
    '--settings',
    settingsPath,
    '--system-prompt',
    '.',
    '--no-session-persistence'
  ]
}

export interface PlanProbeTarget {
  binary: string
  binaryArgs: string[]
}

/**
 * Whether the composition root may run the check, and with which program. Tests never spawn a real
 * CLI: under `HARNESS_E2E=1` or Vitest the check is off, unless `HARNESS_PLAN_PROBE_BIN` names a
 * fake (e2e opt-in; ignored in a packaged app). `undefined` means off.
 */
export function planProbeTarget(
  env: NodeJS.ProcessEnv,
  claudeBinary: string,
  isPackaged: boolean
): PlanProbeTarget | undefined {
  const override = env['HARNESS_PLAN_PROBE_BIN']
  if (override && !isPackaged) return { binary: override, binaryArgs: [] }
  if (env['HARNESS_E2E'] === '1' || env['VITEST']) return undefined
  return { binary: claudeBinary, binaryArgs: [] }
}

export interface ClaudePlanProbeDeps {
  supervisor: Pick<ProcessSupervisor, 'spawn'>
  binary: string
  binaryArgs?: readonly string[]
  resolvePath: () => Promise<string>
  /** The stable empty folder the CLI runs in (`userData/plan-probe`). */
  cwd: string
  /** Where the generated `{"disableAllHooks":true}` settings file is written. */
  settingsPath: string
  models: { cheapestFor: (provider: 'claude') => ModelRef | undefined }
  plans: {
    ingest: (provider: 'claude', windows: readonly RateLimitWindow[], source: 'probe') => void
  }
  recorder: { recordPlanCheck: (usage: PlanCheckUsage) => boolean }
  /** The setting `usage.checkClaudePlanOnLaunch`. */
  isEnabled: () => boolean
  /** Claude's status is `ok`. */
  isClaudeReady: () => boolean
  /** The rate-limit gate of a session is waiting for the limit. */
  isRateLimitPaused: () => boolean
  log: { warn: (message: string, ...rest: unknown[]) => void }
  env?: NodeJS.ProcessEnv
  extraEnv?: Readonly<Record<string, string>>
  timeoutMs?: number
  stopGraceMs?: number
}

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>

/** Runs the check at most once per launch. */
export class ClaudePlanProbe {
  private started = false

  constructor(private readonly deps: ClaudePlanProbeDeps) {}

  /**
   * Call after the provider status check. Never rejects; a failure leaves the meter as it was and
   * writes one warning. Returns true when the CLI was started.
   */
  async runOnce(): Promise<boolean> {
    if (this.started) return false
    const { deps } = this
    if (!deps.isEnabled() || !deps.isClaudeReady() || deps.isRateLimitPaused()) return false
    this.started = true
    try {
      await this.run()
    } catch (error: unknown) {
      deps.log.warn('the Claude plan check failed', error)
    }
    return true
  }

  private async run(): Promise<void> {
    const { deps } = this
    const model = deps.models.cheapestFor('claude')
    if (!model) {
      deps.log.warn('the Claude plan check was skipped: no lightest Claude model is listed')
      return
    }
    const path = await deps.resolvePath()
    await mkdir(deps.cwd, { recursive: true })
    await writeFile(deps.settingsPath, JSON.stringify({ disableAllHooks: true }), 'utf8')
    const proc = deps.supervisor.spawn({
      command: deps.binary,
      args: [...(deps.binaryArgs ?? []), ...buildPlanProbeArgs(model.model, deps.settingsPath)],
      cwd: deps.cwd,
      env: buildAgentEnv(deps.env ?? process.env, path, deps.extraEnv),
      agentId: 'plan-check'
    })
    // `-p "."` is the whole prompt; an open stdin pipe would make the CLI wait for more input.
    proc.endStdin()
    const parser = createClaudeParser({ agentId: 'plan-check' })
    let windows: RateLimitWindow[] = []
    const usage: UsageEvent[] = []
    let failure: string | undefined
    const finished = new Promise<void>((resolve) => {
      proc.onLine((line) => {
        for (const event of parser.parse(line)) {
          if (event.type === 'rate-limit' && event.windows && event.windows.length > 0) {
            windows = event.windows
          } else if (event.type === 'usage' && event.scope === 'turn') {
            usage.push(event)
          } else if (event.type === 'error') {
            failure = event.message
          } else if (event.type === 'turn-result') {
            // The rate-limit event comes before `result`; stopping earlier would lose the usage row.
            resolve()
          }
        }
      })
      void proc.exited.then((info) => {
        if (info.spawnError) failure = info.spawnError.message
        else if (info.code !== 0 && windows.length === 0)
          failure ??= info.stderrTail.trim().slice(-300)
        resolve()
      })
    })
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        resolve()
      }, deps.timeoutMs ?? PLAN_PROBE_TIMEOUT_MS)
    })
    try {
      await Promise.race([finished, timeout])
    } finally {
      clearTimeout(timer)
      await this.stop(proc)
    }

    if (usage.length > 0) deps.recorder.recordPlanCheck(this.total(usage))
    if (windows.length > 0) {
      deps.plans.ingest('claude', windows, 'probe')
      return
    }
    deps.log.warn(
      timedOut
        ? 'the Claude plan check timed out'
        : `the Claude plan check reported no limits${failure ? `: ${failure}` : ''}`
    )
  }

  private total(events: readonly UsageEvent[]): PlanCheckUsage {
    const last = events[events.length - 1]
    return {
      provider: 'claude',
      model: last?.model ?? '',
      input: events.reduce((n, e) => n + e.input, 0),
      cacheWrite: events.reduce((n, e) => n + e.cacheWrite, 0),
      cacheRead: events.reduce((n, e) => n + e.cacheRead, 0),
      output: events.reduce((n, e) => n + e.output, 0),
      maxCallInput: events.reduce((n, e) => Math.max(n, e.maxCallInput), 0),
      callCount: events.reduce((n, e) => n + e.callCount, 0),
      contextWindow: last?.contextWindow
    }
  }

  /** Closes stdin, then signals the process group if the CLI is still there (as `command-probe` does). */
  private async stop(proc: ReturnType<ProcessSupervisor['spawn']>): Promise<void> {
    proc.expectExit()
    proc.endStdin()
    if (proc.hasExited()) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.stopGraceMs ?? STOP_GRACE_MS)
      })
    ])
    clearTimeout(timer)
    if (proc.hasExited()) return
    await proc.killLadder([
      { signal: 'SIGTERM', waitMs: KILL_STEP_MS },
      { signal: 'SIGKILL', waitMs: KILL_STEP_MS }
    ])
  }
}
