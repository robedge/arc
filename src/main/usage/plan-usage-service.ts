import type { AgentEvent, RateLimitWindow } from '../agents/agent-events'
import type { PlanNotices } from './plan-notices'
import type { PlanLimitsRepo } from '../db/repositories/plan-limits-repo'
import type { ProviderId, ProviderStatusMap } from '../../shared/types/provider'
import { PROVIDER_IDS } from '../../shared/types/provider'
import { PROVIDER_TRAITS } from '../../shared/provider-traits'
import type {
  PlanLimit,
  PlanMeterState,
  PlanSnapshot,
  ProviderPlan
} from '../../shared/types/usage'

export type PlanSource = PlanLimit['source']

export interface PlanUsageServiceDeps {
  repo: Pick<PlanLimitsRepo, 'upsertObservation' | 'forProvider'>
  /** `ProviderStatusService.get()`: only a provider whose status is `ok` has a meter. */
  providers: () => ProviderStatusMap
  /** Pushes `plan:changed`. */
  publish: (snapshot: PlanSnapshot) => void
  /** Raises and lists the 80%/95% notices; without it no notices are raised. */
  notices?: Pick<PlanNotices, 'observe' | 'pending' | 'dismiss' | 'prune'>
  now?: () => number
  log?: { warn: (message: string, ...rest: unknown[]) => void }
}

/**
 * The newest observation of every plan limit window per provider (tech spec 2.4 and 2.6). Observations
 * arrive from `rate-limit` events of running agents, from the Codex reader and (later) the Claude
 * probe; `plan_limits` keeps the newest per window, and `meters()` turns them into what the title bar
 * shows; `ingest` also raises the plan notices (`plan-notices.ts`).
 */
export class PlanUsageService {
  private readonly now: () => number
  /** Providers whose last read answered with no windows at all. Cleared by the next observation. */
  private readonly notReported = new Set<ProviderId>()
  private readonly planTypes = new Map<ProviderId, string>()
  private ingests = 0

  constructor(private readonly deps: PlanUsageServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  /**
   * Stores the windows as observed now and pushes `plan:changed`. An empty list from a `poll` or
   * `probe` means the provider answered and reports no limit ("Not reported"); from `event` or `push`
   * it just means that event carried no windows, and nothing changes.
   */
  ingest(
    provider: ProviderId,
    windows: readonly RateLimitWindow[],
    source: PlanSource,
    planType?: string
  ): void {
    if (windows.length === 0) {
      if (source !== 'poll' && source !== 'probe') return
      this.notReported.add(provider)
      // The tier still shows next to "Not reported" (Cursor: the subscription from `agent about`).
      if (planType !== undefined && planType !== '') this.planTypes.set(provider, planType)
      this.deps.publish(this.snapshot())
      return
    }
    const observedAt = this.now()
    try {
      for (const w of windows) {
        this.deps.repo.upsertObservation({
          provider,
          windowId: w.windowId,
          label: w.label,
          usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
          resetsAt: w.resetsAt,
          observedAt,
          source,
          planType: planType ?? null
        })
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not store plan limits', error)
      return
    }
    this.notReported.delete(provider)
    this.raiseNotices(provider, windows)
    if (planType !== undefined && planType !== '') this.planTypes.set(provider, planType)
    this.deps.publish(this.snapshot())
  }

  /** One meter per set-up provider, Claude first. */
  meters(): ProviderPlan[] {
    const status = this.deps.providers()
    const nowSeconds = this.now() / 1000
    const plans: ProviderPlan[] = []
    for (const provider of PROVIDER_IDS) {
      if (status[provider]?.state !== 'ok') continue
      const planType = this.planTypes.get(provider)
      const base = planType === undefined ? {} : { planType }
      if (this.notReported.has(provider)) {
        plans.push({ provider, state: 'not-reported', limits: [], ...base })
        continue
      }
      const limits = this.deps.repo
        .forProvider(provider)
        .map((l): PlanLimit => {
          const stale = l.resetsAt !== null && l.resetsAt <= nowSeconds
          return stale ? { ...l, stale: true } : l
        })
        .sort((a, b) => windowOrder(a) - windowOrder(b) || a.windowId.localeCompare(b.windowId))
      plans.push({ provider, state: stateOf(limits), limits, ...base })
    }
    return plans
  }

  snapshot(): PlanSnapshot {
    const plans = this.meters()
    let notices: PlanSnapshot['notices'] = []
    try {
      notices = this.deps.notices?.pending(plans.flatMap((p) => p.limits)) ?? []
    } catch (error: unknown) {
      this.deps.log?.warn('could not read plan notices', error)
    }
    return { plans, notices }
  }

  /** Marks a notice dismissed and pushes the new snapshot. */
  dismissNotice(key: string): void {
    try {
      this.deps.notices?.dismiss(key)
    } catch (error: unknown) {
      this.deps.log?.warn('could not dismiss plan notice', error)
    }
    this.deps.publish(this.snapshot())
  }

  /** Deletes notices from reset periods more than 8 days gone. Run on startup and now and then. */
  pruneNotices(): void {
    try {
      this.deps.notices?.prune()
    } catch (error: unknown) {
      this.deps.log?.warn('could not prune plan notices', error)
    }
  }

  /** Claims a notice for every observed window that has crossed 80% or 95%. */
  private raiseNotices(provider: ProviderId, windows: readonly RateLimitWindow[]): void {
    if (!this.deps.notices) return
    try {
      for (const w of windows) {
        this.deps.notices.observe({
          provider,
          windowId: w.windowId,
          usedPercent: Math.min(100, Math.max(0, w.usedPercent)),
          resetsAt: w.resetsAt
        })
      }
      if (++this.ingests % 50 === 0) this.deps.notices.prune()
    } catch (error: unknown) {
      this.deps.log?.warn('could not raise plan notices', error)
    }
  }

  /** A provider became (or stopped being) set up: the meters change without any new observation. */
  refreshMeters(): void {
    this.deps.publish(this.snapshot())
  }
}

function stateOf(limits: readonly PlanLimit[]): PlanMeterState {
  if (limits.length === 0) return 'waiting'
  return limits.every((l) => l.stale === true) ? 'stale' : 'ok'
}

/** Shortest window first: 5h before Weekly. Unknown windows go last, ordered by id. */
function windowOrder(limit: PlanLimit): number {
  const order = ['five_hour', 'codex:300', 'seven_day', 'codex:10080']
  const i = order.indexOf(limit.windowId)
  return i === -1 ? order.length : i
}

/**
 * Hands the windows of an agent's `rate-limit` event to the plan service. Claude's arrive as `event`,
 * Codex's `account/rateLimits/updated` as `push`. An event without windows changes nothing.
 */
export function forwardRateLimit(
  plans: Pick<PlanUsageService, 'ingest'> | undefined,
  event: Extract<AgentEvent, { type: 'rate-limit' }>
): void {
  if (!plans || !event.windows || event.windows.length === 0) return
  plans.ingest(
    event.provider,
    event.windows,
    PROVIDER_TRAITS[event.provider].planSource,
    event.planType
  )
}
