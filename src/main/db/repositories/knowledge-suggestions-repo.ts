import { and, desc, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { knowledgeSuggestions } from '../schema'
import type { KnowledgeSuggestionAction, KnowledgeSuggestionStatus } from '../schema'

export type KnowledgeSuggestionRow = typeof knowledgeSuggestions.$inferSelect

export interface KnowledgeSuggestionInput {
  id: string
  sessionId: string
  groupId: string
  requestId: string
  action: KnowledgeSuggestionAction
  title: string
  reason: string
  sectionId: string
  sectionName: string
  targetRelPath?: string | null
  proposedName?: string | null
  proposedContent: string
  hunksJson?: string | null
  baseRevision?: string | null
  dedupeKey: string
  createdAt: number
}

export type KnowledgeSuggestionInsertResult =
  | { inserted: true; row: KnowledgeSuggestionRow }
  | { inserted: false; existing: { id: string; status: KnowledgeSuggestionStatus } }

/**
 * Knowledge suggestions, one per `dedupe_key` across every status, so a discarded or accepted row
 * keeps blocking a repeat. The caller computes the key; this repo only stores and enforces it.
 */
export class KnowledgeSuggestionsRepo {
  constructor(private readonly db: DbHandle) {}

  /** Inserts a waiting row, or reports the existing row that holds the same `dedupe_key`. */
  insert(input: KnowledgeSuggestionInput): KnowledgeSuggestionInsertResult {
    const result = this.db
      .insert(knowledgeSuggestions)
      .values({
        id: input.id,
        sessionId: input.sessionId,
        groupId: input.groupId,
        requestId: input.requestId,
        action: input.action,
        title: input.title,
        reason: input.reason,
        sectionId: input.sectionId,
        sectionName: input.sectionName,
        targetRelPath: input.targetRelPath ?? null,
        proposedName: input.proposedName ?? null,
        proposedContent: input.proposedContent,
        hunksJson: input.hunksJson ?? null,
        baseRevision: input.baseRevision ?? null,
        dedupeKey: input.dedupeKey,
        status: 'waiting',
        createdAt: input.createdAt
      })
      .onConflictDoNothing({ target: knowledgeSuggestions.dedupeKey })
      .run()
    if (result.changes > 0) {
      const row = this.get(input.id)
      if (row === undefined) throw new Error('inserted knowledge suggestion vanished')
      return { inserted: true, row }
    }
    const existing = this.db
      .select({ id: knowledgeSuggestions.id, status: knowledgeSuggestions.status })
      .from(knowledgeSuggestions)
      .where(eq(knowledgeSuggestions.dedupeKey, input.dedupeKey))
      .get()
    if (existing === undefined) throw new Error('knowledge suggestion conflict without a row')
    return { inserted: false, existing }
  }

  /** Waiting suggestions of a session, newest first. */
  listWaiting(sessionId: string): KnowledgeSuggestionRow[] {
    return this.db
      .select()
      .from(knowledgeSuggestions)
      .where(
        and(
          eq(knowledgeSuggestions.sessionId, sessionId),
          eq(knowledgeSuggestions.status, 'waiting')
        )
      )
      .orderBy(desc(knowledgeSuggestions.createdAt), desc(knowledgeSuggestions.id))
      .all()
  }

  get(id: string): KnowledgeSuggestionRow | undefined {
    return this.db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.id, id)).get()
  }

  /** The suggestion, of any status, that holds this `dedupe_key`. */
  getByDedupeKey(dedupeKey: string): KnowledgeSuggestionRow | undefined {
    return this.db
      .select()
      .from(knowledgeSuggestions)
      .where(eq(knowledgeSuggestions.dedupeKey, dedupeKey))
      .get()
  }

  /** Resolves a waiting suggestion; false when it was already resolved or does not exist. */
  setOutcome(
    id: string,
    status: Exclude<KnowledgeSuggestionStatus, 'waiting'>,
    now: number,
    editedContent?: string
  ): boolean {
    const result = this.db
      .update(knowledgeSuggestions)
      .set({
        status,
        resolvedAt: now,
        ...(editedContent === undefined ? {} : { editedContent })
      })
      .where(and(eq(knowledgeSuggestions.id, id), eq(knowledgeSuggestions.status, 'waiting')))
      .run()
    return result.changes > 0
  }

  /** Suggestions of any status made for one request, for the per-request cap. */
  countForRequest(sessionId: string, requestId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(knowledgeSuggestions)
      .where(
        and(
          eq(knowledgeSuggestions.sessionId, sessionId),
          eq(knowledgeSuggestions.requestId, requestId)
        )
      )
      .get()
    return row?.n ?? 0
  }

  /** Discards every waiting suggestion of a session and returns their ids. */
  discardAllWaiting(sessionId: string, now: number): string[] {
    return this.db
      .update(knowledgeSuggestions)
      .set({ status: 'discarded', resolvedAt: now })
      .where(
        and(
          eq(knowledgeSuggestions.sessionId, sessionId),
          eq(knowledgeSuggestions.status, 'waiting')
        )
      )
      .returning({ id: knowledgeSuggestions.id })
      .all()
      .map((r) => r.id)
  }
}
