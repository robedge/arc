import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { messages, sessions } from './sessions'

export const AttachmentKind = { Image: 'image', Pdf: 'pdf', Text: 'text' } as const
export type AttachmentKind = (typeof AttachmentKind)[keyof typeof AttachmentKind]

/**
 * A file attached to a user message. No path is stored: it is derived from `session_id`, `id` and
 * `stored_name`. The size limit literal below is `IMPORT_MAX_BYTES` (20 MiB) from `shared/limits`.
 */
export const messageAttachments = sqliteTable(
  'message_attachments',
  {
    /** ULID; also the folder name on disk. */
    id: text('id').primaryKey(),
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** Order within the message. */
    position: integer('position').notNull(),
    kind: text('kind').$type<AttachmentKind>().notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Display name, including "Pasted image 1". */
    name: text('name').notNull(),
    /** Sanitised file name on disk. */
    storedName: text('stored_name').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    unique('message_attachments_message_position_unq').on(table.messageId, table.position),
    check('message_attachments_kind_check', sql`${table.kind} IN ('image','pdf','text')`),
    check('message_attachments_size_check', sql`${table.sizeBytes} BETWEEN 1 AND 20971520`)
  ]
)

export type MessageAttachmentRow = typeof messageAttachments.$inferSelect
export type NewMessageAttachmentRow = typeof messageAttachments.$inferInsert
