import { asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { workerCommits, workers } from '../schema'
import type { NewWorkerCommitRow, WorkerCommitRow } from '../schema'

export type { NewWorkerCommitRow, WorkerCommitRow }

export class CommitsRepo {
  constructor(private readonly db: DbHandle) {}

  add(row: Omit<NewWorkerCommitRow, 'id'>): WorkerCommitRow {
    return this.db.insert(workerCommits).values(row).returning().get()
  }

  listByWorker(workerId: string): WorkerCommitRow[] {
    return this.db
      .select()
      .from(workerCommits)
      .where(eq(workerCommits.workerId, workerId))
      .orderBy(asc(workerCommits.id))
      .all()
  }

  /** Every commit recorded by the session's workers, oldest first. */
  listBySession(sessionId: string): WorkerCommitRow[] {
    return this.db
      .select({ commit: workerCommits })
      .from(workerCommits)
      .innerJoin(workers, eq(workers.id, workerCommits.workerId))
      .where(eq(workers.sessionId, sessionId))
      .orderBy(asc(workerCommits.id))
      .all()
      .map((r) => r.commit)
  }
}
