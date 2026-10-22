import { and, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { planLimits } from '../schema'
import type { PlanLimit } from '../../../shared/types/usage'

type PlanLimitRow = typeof planLimits.$inferSelect

function toPlanLimit(row: PlanLimitRow): PlanLimit {
  return {
    provider: row.provider,
    windowId: row.window,
    label: row.label,
    usedPercent: row.usedPercent,
    resetsAt: row.resetsAt,
    observedAt: row.observedAt,
    source: row.source
  }
}

/** Latest observed plan limit per (provider, window); the newest observation wins. */
export class PlanLimitsRepo {
  constructor(private readonly db: DbHandle) {}

  /**
   * Inserts the observation, or replaces the stored one only when it is at least as new
   * (`observedAt >=`). Returns the row stored afterwards, so an older observation returns the
   * newer stored row unchanged.
   */
  upsertObservation(o: PlanLimit & { planType?: string | null }): PlanLimit {
    const values = {
      label: o.label,
      usedPercent: o.usedPercent,
      resetsAt: o.resetsAt,
      observedAt: o.observedAt,
      source: o.source,
      planType: o.planType ?? null
    }
    this.db
      .insert(planLimits)
      .values({ provider: o.provider, window: o.windowId, ...values })
      .onConflictDoUpdate({
        target: [planLimits.provider, planLimits.window],
        set: values,
        setWhere: sqlGte(o.observedAt)
      })
      .run()
    const row = this.db
      .select()
      .from(planLimits)
      .where(and(eq(planLimits.provider, o.provider), eq(planLimits.window, o.windowId)))
      .get()
    if (!row) throw new Error('plan_limits row missing after upsert')
    return toPlanLimit(row)
  }

  list(): PlanLimit[] {
    return this.db.select().from(planLimits).all().map(toPlanLimit)
  }

  forProvider(provider: string): PlanLimit[] {
    return this.db
      .select()
      .from(planLimits)
      .where(eq(planLimits.provider, provider))
      .all()
      .map(toPlanLimit)
  }
}

function sqlGte(observedAt: number) {
  return sql`${observedAt} >= ${planLimits.observedAt}`
}
