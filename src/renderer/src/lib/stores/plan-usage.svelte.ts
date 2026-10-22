import type { ProviderId } from '@shared/types/provider'
import type { PlanNotice, PlanSnapshot, ProviderPlan } from '@shared/types/usage'

/** Plan limits per set-up provider, with the main process as the source of truth. */
class PlanUsageStore {
  /** Latest plans in the order main sent them (Claude first). */
  plans = $state<ProviderPlan[]>([])

  /** Pending notices for the current reset period. */
  notices = $state<PlanNotice[]>([])

  /** Plans keyed by provider id. */
  byProvider = $derived<Partial<Record<ProviderId, ProviderPlan>>>(
    Object.fromEntries(this.plans.map((p) => [p.provider, p]))
  )

  /** One meter per set-up provider. */
  meters = $derived(this.plans)

  async load(): Promise<void> {
    const result = await window.harness.invoke('plan:get', {})
    if (result.ok) this.apply(result.data)
  }

  /** Replaces the held plans with the snapshot's. */
  apply(snapshot: PlanSnapshot): void {
    this.plans = snapshot.plans
    this.notices = snapshot.notices
  }

  /** Removes the notice at once, asks main to dismiss it, and puts it back if that fails. */
  async dismissNotice(key: string): Promise<void> {
    const before = this.notices
    this.notices = before.filter((n) => n.key !== key)
    try {
      const result = await window.harness.invoke('plan:dismiss-notice', { key })
      if (!result.ok) this.restore(before, key)
    } catch {
      this.restore(before, key)
    }
  }

  private restore(before: PlanNotice[], key: string): void {
    const notice = before.find((n) => n.key === key)
    if (notice && !this.notices.some((n) => n.key === key)) {
      this.notices = before.filter(
        (n) => n.key === key || this.notices.some((c) => c.key === n.key)
      )
    }
  }

  /** Asks main to read the limits now; main throttles. */
  async refresh(): Promise<void> {
    const result = await window.harness.invoke('plan:refresh', {})
    if (result.ok) this.apply(result.data)
  }

  reset(): void {
    this.plans = []
    this.notices = []
  }
}

export const planUsage = new PlanUsageStore()
