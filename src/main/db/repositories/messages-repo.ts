import { and, desc, eq, isNotNull, lt } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { MessageState, messages } from '../schema'
import type { MessageRow, NewMessageRow } from '../schema'

export type { MessageRow, NewMessageRow }

export class MessagesRepo {
  constructor(private readonly db: DbHandle) {}

  /** Inserts and returns the new row (its autoincrement id included). */
  append(row: Omit<NewMessageRow, 'id'>): MessageRow {
    return this.db.insert(messages).values(row).returning().get()
  }

  get(id: number): MessageRow | undefined {
    return this.db.select().from(messages).where(eq(messages.id, id)).get()
  }

  /** Messages that carry a prompt (buttons), oldest first. */
  listPrompts(sessionId: string): MessageRow[] {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), isNotNull(messages.promptJson)))
      .orderBy(messages.id)
      .all()
  }

  setPrompt(id: number, promptJson: string, now: number): void {
    this.db.update(messages).set({ promptJson, updatedAt: now }).where(eq(messages.id, id)).run()
  }

  updateStreaming(id: number, content: string, now: number): void {
    this.db.update(messages).set({ content, updatedAt: now }).where(eq(messages.id, id)).run()
  }

  finalize(id: number, content: string, state: 'complete' | 'stopped', now: number): void {
    this.db
      .update(messages)
      .set({ content, state, updatedAt: now })
      .where(eq(messages.id, id))
      .run()
  }

  /** Up to `limit` rows with id < beforeId (or the newest when null), returned ascending. */
  page(sessionId: string, beforeId: number | null, limit: number): MessageRow[] {
    const where =
      beforeId === null
        ? eq(messages.sessionId, sessionId)
        : and(eq(messages.sessionId, sessionId), lt(messages.id, beforeId))
    return this.db
      .select()
      .from(messages)
      .where(where)
      .orderBy(desc(messages.id))
      .limit(limit)
      .all()
      .reverse()
  }

  latest(sessionId: string, limit: number): MessageRow[] {
    return this.page(sessionId, null, limit)
  }

  /** Startup recovery: streaming rows become stopped. Returns how many changed. */
  recoverStreaming(now: number): number {
    return this.db
      .update(messages)
      .set({ state: MessageState.Stopped, updatedAt: now })
      .where(eq(messages.state, MessageState.Streaming))
      .run().changes
  }
}
