import { asc, eq, inArray } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { messageAttachments } from '../schema'
import type { MessageAttachmentRow, NewMessageAttachmentRow } from '../schema'

/** Files attached to user messages. Paths are derived elsewhere; this repo only stores rows. */
export class MessageAttachmentsRepo {
  constructor(private readonly db: DbHandle) {}

  insertMany(rows: NewMessageAttachmentRow[]): void {
    if (rows.length === 0) return
    this.db.insert(messageAttachments).values(rows).run()
  }

  /** Attachments of the given messages from one query, each list in position order. */
  listForMessages(messageIds: number[]): Map<number, MessageAttachmentRow[]> {
    const byMessage = new Map<number, MessageAttachmentRow[]>()
    if (messageIds.length === 0) return byMessage
    const rows = this.db
      .select()
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, messageIds))
      .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
      .all()
    for (const row of rows) {
      const list = byMessage.get(row.messageId)
      if (list === undefined) byMessage.set(row.messageId, [row])
      else list.push(row)
    }
    return byMessage
  }

  get(id: string): MessageAttachmentRow | undefined {
    return this.db.select().from(messageAttachments).where(eq(messageAttachments.id, id)).get()
  }

  /** The rows of `sessionId` among `ids`, in the order of `ids`; unknown and foreign ids are skipped. */
  getMany(ids: string[], sessionId: string): MessageAttachmentRow[] {
    if (ids.length === 0) return []
    const found = new Map(
      this.db
        .select()
        .from(messageAttachments)
        .where(inArray(messageAttachments.id, ids))
        .all()
        .filter((r) => r.sessionId === sessionId)
        .map((r) => [r.id, r])
    )
    const out: MessageAttachmentRow[] = []
    for (const id of ids) {
      const row = found.get(id)
      if (row !== undefined) out.push(row)
    }
    return out
  }

  /** Every attachment of a session, by message then position. */
  listForSession(sessionId: string): MessageAttachmentRow[] {
    return this.db
      .select()
      .from(messageAttachments)
      .where(eq(messageAttachments.sessionId, sessionId))
      .orderBy(asc(messageAttachments.messageId), asc(messageAttachments.position))
      .all()
  }
}
