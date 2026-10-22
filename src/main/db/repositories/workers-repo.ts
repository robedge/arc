import { and, asc, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { workers } from '../schema'
import type { ProviderId } from '../../../shared/types/provider'
import type { NewWorkerRow, UserControl, WorkerRow, WorkerStatus } from '../schema'

export type { NewWorkerRow, WorkerRow }

const activeStatuses: WorkerStatus[] = ['starting', 'working', 'needs_approval', 'has_question']

export class WorkersRepo {
  constructor(private readonly db: DbHandle) {}

  insert(row: NewWorkerRow): WorkerRow {
    return this.db.insert(workers).values(row).returning().get()
  }

  /** The next per-session worker number (1-based), read inside a transaction. */
  nextNumber(sessionId: string): number {
    const read = (h: DbHandle): number => {
      const row = h
        .select({ top: max(workers.number) })
        .from(workers)
        .where(eq(workers.sessionId, sessionId))
        .get()
      return (row?.top ?? 0) + 1
    }
    return this.db.transaction((tx) => read(tx))
  }

  get(id: string): WorkerRow | undefined {
    return this.db.select().from(workers).where(eq(workers.id, id)).get()
  }

  /** Every worker row of the session, removed ones included (history such as change attribution still needs them). */
  listAllBySession(sessionId: string): WorkerRow[] {
    return this.db
      .select()
      .from(workers)
      .where(eq(workers.sessionId, sessionId))
      .orderBy(asc(workers.number))
      .all()
  }

  /** The session's workers without the removed ones (`workers:remove` keeps the row, hidden). */
  listBySession(sessionId: string): WorkerRow[] {
    return this.db
      .select()
      .from(workers)
      .where(and(eq(workers.sessionId, sessionId), isNull(workers.removedAt)))
      .orderBy(asc(workers.number))
      .all()
  }

  /** `stoppedBy` is stored as given (null clears it). */
  setStatus(
    id: string,
    status: WorkerStatus,
    now: number,
    stoppedBy: WorkerRow['stoppedBy'] = null
  ): void {
    this.db
      .update(workers)
      .set({ status, stoppedBy, updatedAt: now })
      .where(eq(workers.id, id))
      .run()
  }

  /** Soft delete: the row stays so the event log and merge history keep pointing at it. */
  markRemoved(id: string, now: number): void {
    this.db.update(workers).set({ removedAt: now, updatedAt: now }).where(eq(workers.id, id)).run()
  }

  setActivity(id: string, activity: string | null, now: number): void {
    this.db.update(workers).set({ activity, updatedAt: now }).where(eq(workers.id, id)).run()
  }

  setFailure(id: string, reason: string, now: number): void {
    this.db
      .update(workers)
      .set({ status: 'failed', failureReason: reason, updatedAt: now })
      .where(eq(workers.id, id))
      .run()
  }

  setSummary(id: string, summary: string, now: number): void {
    this.db.update(workers).set({ summary, updatedAt: now }).where(eq(workers.id, id)).run()
  }

  setProviderSessionId(id: string, providerSessionId: string, now: number): void {
    this.db
      .update(workers)
      .set({ providerSessionId, updatedAt: now })
      .where(eq(workers.id, id))
      .run()
  }

  /** The provider that actually runs the worker (set before it starts, e.g. on a fallback). */
  setProvider(id: string, provider: ProviderId, now: number): void {
    this.db.update(workers).set({ provider, updatedAt: now }).where(eq(workers.id, id)).run()
  }

  /** Moves a worker that has not started to another provider and model (a fallback). */
  setTarget(id: string, provider: ProviderId, model: string, now: number): void {
    this.db.update(workers).set({ provider, model, updatedAt: now }).where(eq(workers.id, id)).run()
  }

  /** Records a fallback: what was requested and why it did not run. Both are set together. */
  setFallback(id: string, requestedProvider: ProviderId, reason: string, now: number): void {
    this.db
      .update(workers)
      .set({ requestedProvider, fallbackReason: reason, updatedAt: now })
      .where(eq(workers.id, id))
      .run()
  }

  countActive(sessionId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(workers)
      .where(and(eq(workers.sessionId, sessionId), inArray(workers.status, activeStatuses)))
      .get()
    return row?.n ?? 0
  }

  /** Startup recovery: starting/working become stopped (crash). Returns the affected rows, before the change. */
  recoverInterrupted(now: number): WorkerRow[] {
    return this.stopInterrupted(now, 'crash')
  }

  /**
   * Marks every starting/working worker stopped by `by` in one transaction (needs_approval and
   * has_question rows keep their status). Workers the user is in control of are skipped: they are
   * paused, not stopped. Returns the affected rows, before the change.
   */
  stopInterrupted(now: number, by: 'quit' | 'crash'): WorkerRow[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(workers)
        .where(and(inArray(workers.status, ['starting', 'working']), isNull(workers.userControl)))
        .all()
      if (rows.length > 0) {
        tx.update(workers)
          .set({ status: 'stopped', stoppedBy: by, activity: null, updatedAt: now })
          .where(and(inArray(workers.status, ['starting', 'working']), isNull(workers.userControl)))
          .run()
      }
      return rows
    })
  }

  /** Step-in: sets the control overlay and resets the hand-back summary counters. */
  beginControl(id: string, control: UserControl, now: number): void {
    this.db
      .update(workers)
      .set({
        userControl: control,
        controlStartedAt: now,
        controlUserMessages: 0,
        controlLastMessage: null,
        updatedAt: now
      })
      .where(eq(workers.id, id))
      .run()
  }

  /** Switches between 'active' and 'paused' without touching the summary counters. */
  setControl(id: string, control: UserControl, now: number): void {
    this.db
      .update(workers)
      .set({ userControl: control, updatedAt: now })
      .where(eq(workers.id, id))
      .run()
  }

  /** Hand-back: clears the overlay and its counters. */
  endControl(id: string, now: number): void {
    this.db
      .update(workers)
      .set({
        userControl: null,
        controlStartedAt: null,
        controlUserMessages: 0,
        controlLastMessage: null,
        updatedAt: now
      })
      .where(eq(workers.id, id))
      .run()
  }

  /** Counts one typed line and keeps its first 200 characters as the last-message excerpt. */
  recordControlMessage(id: string, text: string, now: number): void {
    this.db
      .update(workers)
      .set({
        controlUserMessages: sql`${workers.controlUserMessages} + 1`,
        controlLastMessage: text.slice(0, 200),
        updatedAt: now
      })
      .where(eq(workers.id, id))
      .run()
  }

  /** The session's workers the user is in control of (removed ones skipped). */
  listControlled(sessionId: string): WorkerRow[] {
    return this.db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.sessionId, sessionId),
          isNotNull(workers.userControl),
          isNull(workers.removedAt)
        )
      )
      .orderBy(asc(workers.number))
      .all()
  }

  /** Quit/crash recovery: every 'active' control becomes 'paused' (the process is gone). Returns the affected rows, before the change. */
  pauseAllActiveControl(now: number = Date.now()): WorkerRow[] {
    return this.db.transaction((tx) => {
      const rows = tx.select().from(workers).where(eq(workers.userControl, 'active')).all()
      if (rows.length > 0) {
        tx.update(workers)
          .set({ userControl: 'paused', updatedAt: now })
          .where(eq(workers.userControl, 'active'))
          .run()
      }
      return rows
    })
  }
}
