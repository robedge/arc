import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { workerHeldMessages } from '../schema'
import type { WorkerHeldMessageRow } from '../schema'

export type { WorkerHeldMessageRow }

/** Brain messages held for a worker the user is in control of; delivered, in order, at hand-back. */
export class HeldMessagesRepo {
  constructor(private readonly db: DbHandle) {}

  enqueue(workerId: string, sessionId: string, body: string, now: number): WorkerHeldMessageRow {
    return this.db
      .insert(workerHeldMessages)
      .values({ workerId, sessionId, body, createdAt: now })
      .returning()
      .get()
  }

  /** Oldest first (the autoincrement id sets the delivery order). */
  listUndelivered(workerId: string): WorkerHeldMessageRow[] {
    return this.db
      .select()
      .from(workerHeldMessages)
      .where(and(eq(workerHeldMessages.workerId, workerId), isNull(workerHeldMessages.deliveredAt)))
      .orderBy(asc(workerHeldMessages.id))
      .all()
  }

  /** Rows are kept for audit; only `delivered_at` is set. */
  markDelivered(ids: number[], now: number): void {
    if (ids.length === 0) return
    this.db
      .update(workerHeldMessages)
      .set({ deliveredAt: now })
      .where(inArray(workerHeldMessages.id, ids))
      .run()
  }
}
