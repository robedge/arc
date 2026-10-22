import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { workerWorktrees, workers } from '../schema'
import type { NewWorkerWorktreeRow, WorkerWorktreeRow } from '../schema'

export type { NewWorkerWorktreeRow, WorkerWorktreeRow }

export class WorktreesRepo {
  constructor(private readonly db: DbHandle) {}

  insert(row: Omit<NewWorkerWorktreeRow, 'id'>): WorkerWorktreeRow {
    return this.db.insert(workerWorktrees).values(row).returning().get()
  }

  listByWorker(workerId: string): WorkerWorktreeRow[] {
    return this.db
      .select()
      .from(workerWorktrees)
      .where(eq(workerWorktrees.workerId, workerId))
      .orderBy(asc(workerWorktrees.id))
      .all()
  }

  /** Every worktree row of the session's workers. */
  listBySession(sessionId: string): WorkerWorktreeRow[] {
    return this.db
      .select({ row: workerWorktrees })
      .from(workerWorktrees)
      .innerJoin(workers, eq(workers.id, workerWorktrees.workerId))
      .where(eq(workers.sessionId, sessionId))
      .orderBy(asc(workerWorktrees.id))
      .all()
      .map((r) => r.row)
  }

  setHeadSha(id: number, headSha: string): void {
    this.db.update(workerWorktrees).set({ headSha }).where(eq(workerWorktrees.id, id)).run()
  }

  markRemoved(id: number, now: number): void {
    this.db.update(workerWorktrees).set({ removedAt: now }).where(eq(workerWorktrees.id, id)).run()
  }

  setControlBase(id: number, controlBaseSha: string): void {
    this.db.update(workerWorktrees).set({ controlBaseSha }).where(eq(workerWorktrees.id, id)).run()
  }

  /** The worker's live worktrees that have a step-in base recorded (removed rows skipped). */
  listControlBases(workerId: string): WorkerWorktreeRow[] {
    return this.db
      .select()
      .from(workerWorktrees)
      .where(
        and(
          eq(workerWorktrees.workerId, workerId),
          isNull(workerWorktrees.removedAt),
          isNotNull(workerWorktrees.controlBaseSha)
        )
      )
      .orderBy(asc(workerWorktrees.id))
      .all()
  }

  /** Clears every step-in base of the worker (hand-back). */
  clearControlBase(workerId: string): void {
    this.db
      .update(workerWorktrees)
      .set({ controlBaseSha: null })
      .where(eq(workerWorktrees.workerId, workerId))
      .run()
  }
}
