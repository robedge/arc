import { and, desc, eq, lt } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { events } from '../schema'
import type { EventRow, NewEventRow } from '../schema'

export type { EventRow, NewEventRow }

export class EventsRepo {
  constructor(private readonly db: DbHandle) {}

  append(row: Omit<NewEventRow, 'id'>): EventRow {
    return this.db.insert(events).values(row).returning().get()
  }

  /** One transaction; returns the inserted rows in order. */
  appendMany(rows: readonly Omit<NewEventRow, 'id'>[]): EventRow[] {
    if (rows.length === 0) return []
    return this.db.transaction((tx) =>
      rows.map((r) => tx.insert(events).values(r).returning().get())
    )
  }

  /** Up to `limit` rows with id < beforeId (or the newest when null), returned ascending. */
  page(sessionId: string, beforeId: number | null, limit: number): EventRow[] {
    const where =
      beforeId === null
        ? eq(events.sessionId, sessionId)
        : and(eq(events.sessionId, sessionId), lt(events.id, beforeId))
    return this.db
      .select()
      .from(events)
      .where(where)
      .orderBy(desc(events.id))
      .limit(limit)
      .all()
      .reverse()
  }

  /** True when the session already has an event of this kind. */
  hasKind(sessionId: string, kind: string): boolean {
    return (
      this.db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.sessionId, sessionId), eq(events.kind, kind)))
        .limit(1)
        .get() !== undefined
    )
  }

  latest(sessionId: string, limit: number): EventRow[] {
    return this.page(sessionId, null, limit)
  }
}
