import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { reviewNotes, sessionProjects } from '../schema'
import type { NewReviewNoteRow, ReviewNoteRow } from '../schema'

export type { NewReviewNoteRow, ReviewNoteRow }

export interface SessionReviewNote extends ReviewNoteRow {
  projectId: string | null
  sessionId: string
}

const draftOnly = (id: string) => and(eq(reviewNotes.id, id), eq(reviewNotes.state, 'draft'))

/** Thrown inside markSent's transaction to roll it back. */
class NotAllDraftsError extends Error {}

/**
 * Conventions: guarded mutations (`update`, `delete`, `markSent`) return false, never throw,
 * when a note is missing or already sent; nothing is changed in that case.
 */
export class ReviewNotesRepo {
  constructor(private readonly db: DbHandle) {}

  create(row: NewReviewNoteRow): ReviewNoteRow {
    return this.db.insert(reviewNotes).values(row).returning().get()
  }

  get(id: string): SessionReviewNote | undefined {
    return this.db
      .select({
        ...columns(),
        projectId: sessionProjects.projectId,
        sessionId: sessionProjects.sessionId
      })
      .from(reviewNotes)
      .innerJoin(sessionProjects, eq(sessionProjects.id, reviewNotes.sessionProjectId))
      .where(eq(reviewNotes.id, id))
      .get()
  }

  listBySessionProject(sessionProjectId: number, path?: string): ReviewNoteRow[] {
    return this.db
      .select()
      .from(reviewNotes)
      .where(
        and(
          eq(reviewNotes.sessionProjectId, sessionProjectId),
          path === undefined ? undefined : eq(reviewNotes.path, path)
        )
      )
      .orderBy(asc(reviewNotes.createdAt), asc(reviewNotes.id))
      .all()
  }

  listBySession(sessionId: string): SessionReviewNote[] {
    return this.db
      .select({
        ...columns(),
        projectId: sessionProjects.projectId,
        sessionId: sessionProjects.sessionId
      })
      .from(reviewNotes)
      .innerJoin(sessionProjects, eq(sessionProjects.id, reviewNotes.sessionProjectId))
      .where(eq(sessionProjects.sessionId, sessionId))
      .orderBy(asc(reviewNotes.createdAt), asc(reviewNotes.id))
      .all()
  }

  listDrafts(sessionId: string): SessionReviewNote[] {
    return this.listBySession(sessionId).filter((n) => n.state === 'draft')
  }

  countDrafts(sessionId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(reviewNotes)
      .innerJoin(sessionProjects, eq(sessionProjects.id, reviewNotes.sessionProjectId))
      .where(and(eq(sessionProjects.sessionId, sessionId), eq(reviewNotes.state, 'draft')))
      .get()
    return row?.n ?? 0
  }

  /** Draft only; false when the note is sent or missing. */
  update(id: string, body: string, at: number = Date.now()): boolean {
    return (
      this.db.update(reviewNotes).set({ body, updatedAt: at }).where(draftOnly(id)).run()
        .changes === 1
    )
  }

  /** Draft only; false when the note is sent or missing. */
  delete(id: string): boolean {
    return this.db.delete(reviewNotes).where(draftOnly(id)).run().changes === 1
  }

  /** All-or-nothing: false (and no change) unless every id is an existing draft. */
  markSent(ids: readonly string[], messageId: number, at: number = Date.now()): boolean {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return true
    try {
      this.db.transaction((tx) => {
        const changes = tx
          .update(reviewNotes)
          .set({ state: 'sent', messageId, updatedAt: at })
          .where(and(inArray(reviewNotes.id, unique), eq(reviewNotes.state, 'draft')))
          .run().changes
        if (changes !== unique.length) throw new NotAllDraftsError()
      })
      return true
    } catch (e) {
      if (e instanceof NotAllDraftsError) return false
      throw e
    }
  }
}

function columns() {
  return {
    id: reviewNotes.id,
    sessionProjectId: reviewNotes.sessionProjectId,
    path: reviewNotes.path,
    side: reviewNotes.side,
    line: reviewNotes.line,
    lineText: reviewNotes.lineText,
    body: reviewNotes.body,
    state: reviewNotes.state,
    messageId: reviewNotes.messageId,
    createdAt: reviewNotes.createdAt,
    updatedAt: reviewNotes.updatedAt
  }
}
