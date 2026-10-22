import { asc, eq, isNull, lt } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { planNotices } from '../schema'

export type PlanNoticeRow = typeof planNotices.$inferSelect

export interface ClaimNoticeInput {
  key: string
  provider: string
  window: string
  threshold: 80 | 95
  resetsAt: number | null
  now: number
}

/** Notices already raised per limit window and reset period; `claim` makes each fire once. */
export class PlanNoticesRepo {
  constructor(private readonly db: DbHandle) {}

  /** Inserts the notice; true only when it was new (so the caller should push it). */
  claim(input: ClaimNoticeInput): boolean {
    const result = this.db
      .insert(planNotices)
      .values({
        key: input.key,
        provider: input.provider,
        window: input.window,
        threshold: input.threshold,
        resetsAt: input.resetsAt,
        notifiedAt: input.now
      })
      .onConflictDoNothing()
      .run()
    return result.changes > 0
  }

  dismiss(key: string, now: number): void {
    this.db.update(planNotices).set({ dismissedAt: now }).where(eq(planNotices.key, key)).run()
  }

  /** Notices not yet dismissed, oldest first. */
  pending(): PlanNoticeRow[] {
    return this.db
      .select()
      .from(planNotices)
      .where(isNull(planNotices.dismissedAt))
      .orderBy(asc(planNotices.notifiedAt))
      .all()
  }

  /** Deletes notices whose reset (epoch seconds) is before the cutoff. Returns the count. */
  prune(beforeEpochSeconds: number): number {
    return this.db.delete(planNotices).where(lt(planNotices.resetsAt, beforeEpochSeconds)).run()
      .changes
  }
}
