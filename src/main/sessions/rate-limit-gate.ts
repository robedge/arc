import { providerName } from '../../shared/provider-label'
import type { ProviderId } from '../../shared/types/provider'

/**
 * Usage-limit handling shared by the brain and the workers of one session (tech spec 2.10): an agent
 * that hits the limit waits, the worker queue stops starting workers on that provider, and the agent
 * is retried once after the limit resets (or after five minutes when the CLI said nothing). Never a retry loop: one
 * pending retry per agent, and the next one is only scheduled by a new limit event after it ran.
 */

export const RATE_LIMIT_RETRY_MS = 5 * 60 * 1000
/** A little after `resetsAt`, so the retry does not land on the exact second the limit lifts. */
const RESET_MARGIN_MS = 1000

export interface RateLimitGateDeps {
  now: () => number
  /** "Waiting for the Claude usage limit (resets 14:05)". */
  logEvent: (kind: string, text: string, data?: unknown, workerId?: string | null) => void
  /** The last pending retry of a provider ran or was cancelled: its held workers can start again. */
  onResumed: () => void
  log: { warn: (message: string, ...rest: unknown[]) => void }
}

export interface RateLimitHit {
  /** Epoch seconds, as the CLI reports it. */
  resetsAt?: number | undefined
  /** The provider whose limit was hit; names it in the log line. Defaults to Claude. */
  provider?: ProviderId | undefined
  /** Runs once when the wait is over. */
  retry: () => void | Promise<void>
  /** Event-log association. */
  workerId?: string | null
}

function clock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export class RateLimitGate {
  private readonly pending = new Map<
    string,
    { timer: NodeJS.Timeout; known: boolean; provider: ProviderId }
  >()
  private disposed = false
  /** When the last retry of a provider ran. */
  private readonly lastRetry = new Map<ProviderId, number>()
  /** Until when a provider counts as limited for new work. */
  private readonly heldUntil = new Map<ProviderId, number>()

  constructor(private readonly deps: RateLimitGateDeps) {}

  /** True while any agent waits for this provider's limit: no worker may be started on it. */
  isProviderWaiting(provider: ProviderId): boolean {
    for (const entry of this.pending.values()) {
      if (entry.provider === provider) return true
    }
    return false
  }

  /** Providers whose retry failed: new work should not start on them yet. */
  limitedProviders(): ReadonlySet<ProviderId> {
    const now = this.deps.now()
    const held = new Set<ProviderId>()
    for (const [provider, until] of this.heldUntil) {
      if (until > now) held.add(provider)
      else this.heldUntil.delete(provider)
    }
    return held
  }

  isWaiting(agentId: string): boolean {
    return this.pending.has(agentId)
  }

  /**
   * Records that an agent hit the limit. Returns false when its retry is already scheduled; a second
   * report only moves that retry, and only when the first one had no reset time and this one has.
   */
  hit(agentId: string, hit: RateLimitHit): boolean {
    if (this.disposed) return false
    const now = this.deps.now()
    const resetMs = hit.resetsAt === undefined ? undefined : hit.resetsAt * 1000
    const known = resetMs !== undefined && resetMs > now
    const existing = this.pending.get(agentId)
    if (existing && (existing.known || !known)) return false
    if (existing) clearTimeout(existing.timer)
    const delay = known ? resetMs - now + RESET_MARGIN_MS : RATE_LIMIT_RETRY_MS
    const provider = hit.provider ?? 'claude'
    const name = providerName(provider)
    const retried = this.lastRetry.get(provider)
    if (provider !== 'claude' && retried !== undefined && now - retried <= RATE_LIMIT_RETRY_MS) {
      this.heldUntil.set(provider, known ? resetMs + RESET_MARGIN_MS : now + RATE_LIMIT_RETRY_MS)
    }
    this.deps.logEvent(
      'rate-limit',
      known
        ? `Waiting for the ${name} usage limit (resets ${clock(resetMs)})`
        : `Waiting for the ${name} usage limit (trying again in 5 minutes)`,
      known ? { resetsAt: hit.resetsAt } : undefined,
      hit.workerId ?? null
    )
    const timer = setTimeout(() => {
      this.pending.delete(agentId)
      this.lastRetry.set(provider, this.deps.now())
      void this.run(hit)
      if (!this.isProviderWaiting(provider)) this.deps.onResumed()
    }, delay)
    timer.unref()
    this.pending.set(agentId, { timer, known, provider })
    return existing === undefined
  }

  /**
   * The agent's retry is not needed: it was stopped by the user, moved to another model, or ended
   * a turn without the limit. Workers held by its provider can start when it was the last wait.
   */
  cancel(agentId: string): void {
    const entry = this.pending.get(agentId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(agentId)
    if (!this.isProviderWaiting(entry.provider) && !this.disposed) this.deps.onResumed()
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.pending.values()) clearTimeout(entry.timer)
    this.pending.clear()
  }

  private async run(hit: RateLimitHit): Promise<void> {
    try {
      await hit.retry()
    } catch (error: unknown) {
      this.deps.log.warn('could not continue after the usage limit', error)
    }
  }
}
