import { and, asc, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { attentionRequests, sessions } from '../schema'
import type { AttentionRequestRow, AttentionStatus, NewAttentionRequestRow } from '../schema'

export type { AttentionRequestRow, NewAttentionRequestRow }

const pending = sql`${attentionRequests.status} = 'pending'`
/** The Needs-attention queue; requests answered in a worker's terminal are not in it. */
const queued = sql`${attentionRequests.route} = 'queue'`

export class AttentionRepo {
  constructor(private readonly db: DbHandle) {}

  create(row: NewAttentionRequestRow): AttentionRequestRow {
    return this.db.insert(attentionRequests).values(row).returning().get()
  }

  get(id: string): AttentionRequestRow | undefined {
    return this.db.select().from(attentionRequests).where(eq(attentionRequests.id, id)).get()
  }

  listPending(sessionId: string): AttentionRequestRow[] {
    return this.db
      .select()
      .from(attentionRequests)
      .where(and(eq(attentionRequests.sessionId, sessionId), pending))
      .orderBy(asc(attentionRequests.createdAt), asc(attentionRequests.id))
      .all()
  }

  /**
   * Pending requests that were passed to the user, in the queue or in a worker's terminal (each row
   * carries its `route`; the counts below take the queue only).
   */
  listPendingEscalated(sessionId: string): AttentionRequestRow[] {
    return this.db
      .select()
      .from(attentionRequests)
      .where(
        and(
          eq(attentionRequests.sessionId, sessionId),
          pending,
          eq(attentionRequests.escalated, true)
        )
      )
      .orderBy(asc(attentionRequests.createdAt), asc(attentionRequests.id))
      .all()
  }

  /** The brain passes a request on to the user. */
  markEscalated(id: string, brainNote: string | null): void {
    this.db
      .update(attentionRequests)
      .set({ escalated: true, brainNote })
      .where(eq(attentionRequests.id, id))
      .run()
  }

  /** Resolves a pending request only; returns false if it was already resolved or is missing. */
  resolve(
    id: string,
    status: Exclude<AttentionStatus, 'pending'>,
    answer: string | null,
    now: number
  ): boolean {
    const result = this.db
      .update(attentionRequests)
      .set({ status, answer, resolvedAt: now })
      .where(and(eq(attentionRequests.id, id), pending))
      .run()
    return result.changes > 0
  }

  /**
   * Startup: pending `AskUserQuestion` rows lost their call with the worker process. They become
   * `cancelled` and stay undelivered, so the resumed worker is told to ask again. Returns the rows.
   */
  cancelPendingToolQuestions(toolName: string, now: number): AttentionRequestRow[] {
    return this.db.transaction((tx) => {
      const rows = tx
        .select()
        .from(attentionRequests)
        .where(and(pending, eq(attentionRequests.toolName, toolName)))
        .all()
      for (const row of rows) {
        tx.update(attentionRequests)
          .set({ status: 'cancelled', resolvedAt: now })
          .where(eq(attentionRequests.id, row.id))
          .run()
      }
      return rows
    })
  }

  /** The worker's pending requests that are answered in its terminal. */
  listPendingForTerminal(workerId: string): AttentionRequestRow[] {
    return this.db
      .select()
      .from(attentionRequests)
      .where(
        and(
          eq(attentionRequests.workerId, workerId),
          pending,
          eq(attentionRequests.route, 'terminal')
        )
      )
      .orderBy(asc(attentionRequests.createdAt), asc(attentionRequests.id))
      .all()
  }

  /**
   * Step-in: the worker's pending queue requests move to its terminal, and count as passed to the
   * user. Returns the moved rows.
   */
  rerouteToTerminal(workerId: string): AttentionRequestRow[] {
    return this.db
      .update(attentionRequests)
      .set({ route: 'terminal', escalated: true })
      .where(and(eq(attentionRequests.workerId, workerId), pending, queued))
      .returning()
      .all()
  }

  /**
   * Hand-back: the worker's pending terminal requests return to the queue. A request the brain may
   * decide (not must-escalate) is no longer passed on, so the brain-first path runs again. Returns
   * the moved rows.
   */
  routeBack(workerId: string): AttentionRequestRow[] {
    return this.db
      .update(attentionRequests)
      .set({
        route: 'queue',
        escalated: sql`${attentionRequests.mustEscalate}`,
        brainNote: sql`CASE WHEN ${attentionRequests.mustEscalate} THEN ${attentionRequests.brainNote} ELSE NULL END`
      })
      .where(
        and(
          eq(attentionRequests.workerId, workerId),
          pending,
          eq(attentionRequests.route, 'terminal')
        )
      )
      .returning()
      .all()
  }

  markDelivered(id: string): void {
    this.db
      .update(attentionRequests)
      .set({ delivered: true })
      .where(eq(attentionRequests.id, id))
      .run()
  }

  countPendingEscalatedBySession(sessionId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(attentionRequests)
      .where(
        and(
          eq(attentionRequests.sessionId, sessionId),
          pending,
          eq(attentionRequests.escalated, true),
          queued
        )
      )
      .get()
    return row?.n ?? 0
  }

  /** Groups with no pending escalated request are absent. */
  countPendingEscalatedByGroup(): Record<string, number> {
    const rows = this.db
      .select({ groupId: sessions.groupId, n: sql<number>`count(*)` })
      .from(attentionRequests)
      .innerJoin(sessions, eq(sessions.id, attentionRequests.sessionId))
      .where(and(pending, eq(attentionRequests.escalated, true), queued))
      .groupBy(sessions.groupId)
      .all()
    return Object.fromEntries(rows.map((r) => [r.groupId, r.n]))
  }

  /** Resolved requests whose answer has not reached the agent yet (for resume), optionally for one worker. */
  listUndelivered(sessionId: string, workerId?: string): AttentionRequestRow[] {
    return this.db
      .select()
      .from(attentionRequests)
      .where(
        and(
          eq(attentionRequests.sessionId, sessionId),
          sql`${attentionRequests.status} <> 'pending'`,
          eq(attentionRequests.delivered, false),
          workerId === undefined ? undefined : eq(attentionRequests.workerId, workerId)
        )
      )
      .orderBy(asc(attentionRequests.resolvedAt), asc(attentionRequests.id))
      .all()
  }
}
