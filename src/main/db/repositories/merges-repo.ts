import { asc, desc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { merges } from '../schema'
import type { MergeRow, NewMergeRow } from '../schema'

export type { MergeRow, NewMergeRow }

export class MergesRepo {
  constructor(private readonly db: DbHandle) {}

  record(row: NewMergeRow): MergeRow {
    return this.db.insert(merges).values(row).returning().get()
  }

  /** Oldest first. */
  listBySession(sessionId: string): MergeRow[] {
    return this.db
      .select()
      .from(merges)
      .where(eq(merges.sessionId, sessionId))
      .orderBy(asc(merges.mergedAt), asc(merges.id))
      .all()
  }

  /** Oldest first. */
  listByWorker(workerId: string): MergeRow[] {
    return this.db
      .select()
      .from(merges)
      .where(eq(merges.workerId, workerId))
      .orderBy(asc(merges.mergedAt), asc(merges.id))
      .all()
  }

  latestForWorker(workerId: string): MergeRow | undefined {
    return this.db
      .select()
      .from(merges)
      .where(eq(merges.workerId, workerId))
      .orderBy(desc(merges.mergedAt), desc(merges.id))
      .limit(1)
      .get()
  }
}
