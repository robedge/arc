import type { CodexRateLimitSource } from '../agents/codex/codex-probe'
import type { ProviderStatusMap } from '../../shared/types/provider'
import type { PlanUsageService } from './plan-usage-service'

/** Codex limits are read again this often while Arc runs. */
export const CODEX_LIMITS_POLL_MS = 5 * 60 * 1000
/** A focus within this long of the last read does not start another. */
export const CODEX_LIMITS_FOCUS_GAP_MS = 30 * 1000

export interface CodexRateLimitReaderDeps {
  /** `CodexProbe`: `account/rateLimits/read` through a short-lived app-server. No model call. */
  source: CodexRateLimitSource
  plans: Pick<PlanUsageService, 'ingest'>
  /** `ProviderStatusService.get()`: nothing is read unless Codex is `ok`. */
  status: () => ProviderStatusMap
  intervalMs?: number
  focusGapMs?: number
  now?: () => number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/**
 * Feeds the Codex plan meter without any agent running (tech spec 2.4). It reads on launch, on window
 * focus and every five minutes; calls that overlap share one request, and nothing is read while Codex
 * is not set up. A failed read keeps the last value and is only logged.
 */
export class CodexRateLimitReader {
  private inflight: Promise<void> | undefined
  private timer: NodeJS.Timeout | undefined
  private lastReadAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(private readonly deps: CodexRateLimitReaderDeps) {}

  /** Reads now and then every five minutes. The timer never keeps the process alive. */
  start(): void {
    if (this.disposed || this.timer) return
    this.timer = setInterval(
      () => void this.refresh(),
      this.deps.intervalMs ?? CODEX_LIMITS_POLL_MS
    )
    this.timer.unref()
    void this.refresh()
  }

  /** The window regained focus: reads unless a read just finished. */
  onFocus(): void {
    const now = (this.deps.now ?? Date.now)()
    if (now - this.lastReadAt < (this.deps.focusGapMs ?? CODEX_LIMITS_FOCUS_GAP_MS)) return
    void this.refresh()
  }

  /** Reads now (`plan:refresh`). Concurrent calls share one request. Never rejects. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inflight) return this.inflight
    if (this.deps.status().codex?.state !== 'ok') return Promise.resolve()
    const task = this.read().finally(() => {
      this.inflight = undefined
    })
    this.inflight = task
    return task
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async read(): Promise<void> {
    try {
      const { windows, planType } = await this.deps.source.readRateLimits()
      this.lastReadAt = (this.deps.now ?? Date.now)()
      if (this.disposed) return
      this.deps.plans.ingest('codex', windows, 'poll', planType)
    } catch (error: unknown) {
      this.lastReadAt = (this.deps.now ?? Date.now)()
      this.deps.log?.warn('could not read the Codex plan limits', error)
    }
  }
}
