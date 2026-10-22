import { asc, desc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { plans } from '../schema'
import type { NewPlanRow, PlanRow, PlanStatus } from '../schema'

export type { NewPlanRow, PlanRow }

export class PlansRepo {
  constructor(private readonly db: DbHandle) {}

  insert(row: NewPlanRow): PlanRow {
    return this.db.insert(plans).values(row).returning().get()
  }

  get(id: string): PlanRow | undefined {
    return this.db.select().from(plans).where(eq(plans.id, id)).get()
  }

  /** The newest plan of the session, or undefined. */
  latest(sessionId: string): PlanRow | undefined {
    return this.db
      .select()
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .orderBy(desc(plans.createdAt), desc(plans.id))
      .limit(1)
      .get()
  }

  setMessageId(id: string, messageId: number): void {
    this.db.update(plans).set({ messageId }).where(eq(plans.id, id)).run()
  }

  setWorkersJson(id: string, workersJson: string): void {
    this.db.update(plans).set({ workersJson }).where(eq(plans.id, id)).run()
  }

  /** Every plan of the session, oldest first. */
  listBySession(sessionId: string): PlanRow[] {
    return this.db
      .select()
      .from(plans)
      .where(eq(plans.sessionId, sessionId))
      .orderBy(asc(plans.createdAt), asc(plans.id))
      .all()
  }

  /** "Ask for changes": the plan stays `proposed`, and `resolved_at` marks that the user answered. */
  markChangesRequested(id: string, now: number): void {
    this.db.update(plans).set({ status: 'proposed', resolvedAt: now }).where(eq(plans.id, id)).run()
  }

  setStatus(id: string, status: PlanStatus, now: number): void {
    const resolvedAt = status === 'proposed' ? null : now
    this.db.update(plans).set({ status, resolvedAt }).where(eq(plans.id, id)).run()
  }

  markReplaced(oldId: string, newId: string, now: number): void {
    this.db
      .update(plans)
      .set({ status: 'replaced', replacedById: newId, resolvedAt: now })
      .where(eq(plans.id, oldId))
      .run()
  }
}
