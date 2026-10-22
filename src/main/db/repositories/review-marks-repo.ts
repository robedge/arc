import { and, asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { reviewFileMarks, sessionProjects } from '../schema'
import type { ReviewFileMarkRow } from '../schema'

export type { ReviewFileMarkRow }

export interface SessionReviewMark {
  sessionProjectId: number
  projectId: string | null
  path: string
  fingerprint: string
  markedAt: number
}

export class ReviewMarksRepo {
  constructor(private readonly db: DbHandle) {}

  listByProject(sessionProjectId: number): ReviewFileMarkRow[] {
    return this.db
      .select()
      .from(reviewFileMarks)
      .where(eq(reviewFileMarks.sessionProjectId, sessionProjectId))
      .orderBy(asc(reviewFileMarks.id))
      .all()
  }

  /** Upserts on (session project, path), overwriting fingerprint and marked_at. */
  mark(sessionProjectId: number, path: string, fingerprint: string, at: number = Date.now()): void {
    this.db
      .insert(reviewFileMarks)
      .values({ sessionProjectId, path, fingerprint, markedAt: at })
      .onConflictDoUpdate({
        target: [reviewFileMarks.sessionProjectId, reviewFileMarks.path],
        set: { fingerprint, markedAt: at }
      })
      .run()
  }

  unmark(sessionProjectId: number, path: string): void {
    this.db
      .delete(reviewFileMarks)
      .where(
        and(eq(reviewFileMarks.sessionProjectId, sessionProjectId), eq(reviewFileMarks.path, path))
      )
      .run()
  }

  /** Used by undo; same effect as unmark. */
  deleteByPath(sessionProjectId: number, path: string): void {
    this.unmark(sessionProjectId, path)
  }

  listBySession(sessionId: string): SessionReviewMark[] {
    return this.db
      .select({
        sessionProjectId: reviewFileMarks.sessionProjectId,
        projectId: sessionProjects.projectId,
        path: reviewFileMarks.path,
        fingerprint: reviewFileMarks.fingerprint,
        markedAt: reviewFileMarks.markedAt
      })
      .from(reviewFileMarks)
      .innerJoin(sessionProjects, eq(sessionProjects.id, reviewFileMarks.sessionProjectId))
      .where(eq(sessionProjects.sessionId, sessionId))
      .orderBy(asc(reviewFileMarks.id))
      .all()
  }
}
