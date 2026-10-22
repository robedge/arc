import type { ProviderStatusMap } from '../../shared/types/provider'
import type { PlanUsageService } from './plan-usage-service'

/** The subscription tier is asked of `agent about` at most this often. */
export const CURSOR_TIER_CACHE_MS = 6 * 60 * 60 * 1000
/** A focus within this long of the last update does not push another. */
export const CURSOR_PLAN_FOCUS_GAP_MS = 30 * 1000

export interface CursorPlanReaderDeps {
  /** `CliResolver.cursorSubscriptionTier()`: `agent about --format json`. No model call. */
  tier: () => Promise<string | undefined>
  plans: Pick<PlanUsageService, 'ingest'>
  /** `ProviderStatusService.get()`: nothing is read unless Cursor is `ok`. */
  status: () => ProviderStatusMap
  cacheMs?: number
  focusGapMs?: number
  now?: () => number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/**
 * Feeds the Cursor plan meter (tech spec 2.10). Cursor's ACP reports no plan usage, so the meter
 * reads "Not reported"; this tells the plan service so, with the subscription tier from `agent about`.
 * It runs once Cursor's status is known and on window focus. The tier is cached for six hours, so a
 * focus never spawns the CLI; a failed read keeps the last tier and is only logged.
 */
export class CursorPlanReader {
  private inflight: Promise<void> | undefined
  private tier: { value: string | undefined; at: number } | undefined
  private lastIngestAt = Number.NEGATIVE_INFINITY
  private disposed = false

  constructor(private readonly deps: CursorPlanReaderDeps) {}

  /** The window regained focus: reports again unless that just happened. */
  onFocus(): void {
    const now = (this.deps.now ?? Date.now)()
    if (now - this.lastIngestAt < (this.deps.focusGapMs ?? CURSOR_PLAN_FOCUS_GAP_MS)) return
    void this.refresh()
  }

  /** Reports now (launch, Check again). Concurrent calls share one. Never rejects. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.inflight) return this.inflight
    if (this.deps.status().cursor?.state !== 'ok') return Promise.resolve()
    const task = this.report().finally(() => {
      this.inflight = undefined
    })
    this.inflight = task
    return task
  }

  dispose(): void {
    this.disposed = true
  }

  private async report(): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    try {
      const cached = this.tier
      if (cached === undefined || now - cached.at >= (this.deps.cacheMs ?? CURSOR_TIER_CACHE_MS)) {
        // An unknown tier is not cached past a failure, but keeps the tier last known.
        const value = await this.deps.tier()
        this.tier = {
          value: value ?? cached?.value,
          at: value === undefined ? (cached?.at ?? 0) : now
        }
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not read the Cursor subscription tier', error)
    }
    if (this.disposed) return
    this.lastIngestAt = now
    this.deps.plans.ingest('cursor', [], 'probe', this.tier?.value)
  }
}
