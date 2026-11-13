import { and, asc, count, desc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { ulid } from '../ids'
import { branchQuestions, sessions } from '../schema'
import type { BranchQuestionChoice, BranchQuestionRow } from '../schema'

const pending = eq(branchQuestions.status, 'pending')

/** Questions Arc asks before creating a session branch in a repository with unsaved changes. */
export class BranchQuestionsRepo {
  constructor(private readonly db: DbHandle) {}

  /** The open question for a session project, created if there is none. */
  openFor(sessionId: string, sessionProjectId: number, now: number): BranchQuestionRow {
    const existing = this.getPendingFor(sessionProjectId)
    if (existing !== undefined) return existing
    return this.db
      .insert(branchQuestions)
      .values({ id: ulid(now), sessionId, sessionProjectId, status: 'pending', createdAt: now })
      .returning()
      .get()
  }

  getById(id: string): BranchQuestionRow | undefined {
    return this.db.select().from(branchQuestions).where(eq(branchQuestions.id, id)).get()
  }

  /** The newest answered question of a session project, if any. */
  lastAnsweredFor(sessionProjectId: number): BranchQuestionRow | undefined {
    return this.db
      .select()
      .from(branchQuestions)
      .where(
        and(
          eq(branchQuestions.sessionProjectId, sessionProjectId),
          eq(branchQuestions.status, 'answered')
        )
      )
      .orderBy(desc(branchQuestions.resolvedAt), desc(branchQuestions.id))
      .get()
  }

  /** Open questions of a session, oldest first. */
  listPending(sessionId: string): BranchQuestionRow[] {
    return this.db
      .select()
      .from(branchQuestions)
      .where(and(eq(branchQuestions.sessionId, sessionId), pending))
      .orderBy(asc(branchQuestions.createdAt), asc(branchQuestions.id))
      .all()
  }

  countPending(sessionId: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(branchQuestions)
        .where(and(eq(branchQuestions.sessionId, sessionId), pending))
        .get()?.n ?? 0
    )
  }

  countPendingAll(): number {
    return this.db.select({ n: count() }).from(branchQuestions).where(pending).get()?.n ?? 0
  }

  /** Open questions per group, for the Needs attention count of the session list. */
  countPendingByGroup(): Record<string, number> {
    const rows = this.db
      .select({ groupId: sessions.groupId, n: count() })
      .from(branchQuestions)
      .innerJoin(sessions, eq(sessions.id, branchQuestions.sessionId))
      .where(pending)
      .groupBy(sessions.groupId)
      .all()
    return Object.fromEntries(rows.map((r) => [r.groupId, r.n]))
  }

  getPendingFor(sessionProjectId: number): BranchQuestionRow | undefined {
    return this.db
      .select()
      .from(branchQuestions)
      .where(and(eq(branchQuestions.sessionProjectId, sessionProjectId), pending))
      .get()
  }

  /** Marks an open question answered. False when it was already resolved or does not exist. */
  resolve(id: string, choice: BranchQuestionChoice, now: number): boolean {
    return (
      this.db
        .update(branchQuestions)
        .set({ status: 'answered', choice, resolvedAt: now })
        .where(and(eq(branchQuestions.id, id), pending))
        .run().changes > 0
    )
  }

  /**
   * Puts a question back to pending with the reason the chosen way failed. False when the row is
   * missing or another question is already open for the same project.
   */
  reopenWithMessage(id: string, message: string): boolean {
    const row = this.db.select().from(branchQuestions).where(eq(branchQuestions.id, id)).get()
    if (row === undefined || row.status === 'cancelled') return false
    const open = this.getPendingFor(row.sessionProjectId)
    if (open !== undefined && open.id !== id) return false
    return (
      this.db
        .update(branchQuestions)
        .set({ status: 'pending', choice: null, resolvedAt: null, message })
        .where(eq(branchQuestions.id, id))
        .run().changes > 0
    )
  }

  /** Cancels an open question nobody is waiting on. False when it was not open. */
  cancel(id: string, now: number): boolean {
    return (
      this.db
        .update(branchQuestions)
        .set({ status: 'cancelled', resolvedAt: now })
        .where(and(eq(branchQuestions.id, id), pending))
        .run().changes > 0
    )
  }
}
