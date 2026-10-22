/**
 * The quit sequence (tech spec 2.10). Every step is isolated, so a failure is logged and the
 * sequence goes on; it can never keep Arc from quitting.
 */

export interface ShutdownTimings {
  /** Wait for the agents to exit on their own (interrupt, stdin closed) before SIGTERM. */
  graceMs: number
  /** SIGKILL for whatever is still alive, counted from the start of the kill ladder. */
  killAfterMs: number
  /** Hard ceiling for the whole sequence. */
  ceilingMs: number
  pollMs: number
}

export const SHUTDOWN_TIMINGS: ShutdownTimings = {
  graceMs: 1500,
  killAfterMs: 5000,
  ceilingMs: 8000,
  pollMs: 20
}

export interface ShutdownDeps {
  /** 1. Stopped (quit) for running workers and finalized streaming messages, in the database. */
  writeStopped(): void
  /** 2. Pending bridge calls settle as "shutting down"; their attention rows stay pending. */
  settleBridgeCalls(): void
  /** A running plugin change is killed and reports "Cancelled because Arc quit" (optional). */
  cancelPluginOps?(): Promise<void>
  /** 3. Interrupt each agent (stdin closed) and wait for it; may take longer than the ceiling. */
  stopAgents(): Promise<void>
  /** Number of agent process groups that are still alive. */
  liveCount(): number
  signalAll(signal: NodeJS.Signals): void
  /** 5. Revoke tokens, delete the MCP config files, close the bridge. */
  closeBridge(): Promise<void>
  /** 6. Watcher, availability checks, database. */
  cleanup(): void
  log: { warn(message: string, ...rest: unknown[]): void }
  timings?: Partial<ShutdownTimings>
  now?: () => number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function guarded(
  deps: ShutdownDeps,
  name: string,
  step: () => void | Promise<void>
): Promise<void> {
  try {
    await step()
  } catch (error: unknown) {
    deps.log.warn(`shutdown: ${name} failed`, error)
  }
}

export async function runShutdown(deps: ShutdownDeps): Promise<void> {
  const t: ShutdownTimings = { ...SHUTDOWN_TIMINGS, ...deps.timings }
  const now = deps.now ?? Date.now
  const startedAt = now()
  const ceiling = startedAt + t.ceilingMs

  await guarded(deps, 'write stopped', () => deps.writeStopped())
  await guarded(deps, 'settle bridge calls', () => deps.settleBridgeCalls())

  const pluginOps = deps.cancelPluginOps
    ? guarded(deps, 'cancel plugin changes', () => deps.cancelPluginOps?.())
    : Promise.resolve()

  const live = (): number => {
    try {
      return deps.liveCount()
    } catch {
      return 0
    }
  }

  // Always asked to stop (flushes buffers, closes handles); it is quick when nothing is running.
  const stopped = guarded(deps, 'stop agents', () => deps.stopAgents())
  const untilCeiling = (): Promise<void> => delay(Math.max(0, ceiling - now()))

  if (live() > 0) {
    let termSent = false
    let killSent = false
    const ladderStart = now()
    const ladder = async (): Promise<void> => {
      while (live() > 0 && now() < ceiling) {
        const elapsed = now() - ladderStart
        if (!termSent && elapsed >= t.graceMs) {
          termSent = true
          await guarded(deps, 'SIGTERM', () => deps.signalAll('SIGTERM'))
        }
        if (!killSent && elapsed >= t.killAfterMs) {
          killSent = true
          await guarded(deps, 'SIGKILL', () => deps.signalAll('SIGKILL'))
        }
        await delay(t.pollMs)
      }
    }
    await Promise.race([ladder(), untilCeiling()])
  }
  await Promise.race([Promise.all([stopped, pluginOps]), untilCeiling()])
  // Final fallback inside the ceiling: nothing may outlive Arc.
  if (live() > 0) await guarded(deps, 'final SIGKILL', () => deps.signalAll('SIGKILL'))

  // server.close() waits for connections; never let it run past the ceiling.
  await guarded(deps, 'close bridge', () =>
    Promise.race([deps.closeBridge(), delay(Math.max(250, ceiling - now()))])
  )
  await guarded(deps, 'cleanup', () => deps.cleanup())
}
