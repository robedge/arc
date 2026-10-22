import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { groups } from './groups'

export const knowledgeStorage = sqliteTable(
  'knowledge_storage',
  {
    groupId: text('group_id')
      .primaryKey()
      .references(() => groups.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['app', 'linked'] }).notNull(),
    linkedPath: text('linked_path'),
    keptAside: integer('kept_aside', { mode: 'boolean' }).notNull().default(false),
    /** Epoch ms when the in-app knowledge was renamed to knowledge.kept/; null when nothing is kept aside. */
    keptAsideAt: integer('kept_aside_at'),
    pendingOp: text('pending_op'),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    check('knowledge_storage_mode_check', sql`${table.mode} IN ('app','linked')`),
    check(
      'knowledge_storage_linked_path_check',
      sql`(${table.mode} = 'linked') = (${table.linkedPath} IS NOT NULL)`
    )
  ]
)

export type KnowledgeStorageRow = typeof knowledgeStorage.$inferSelect
export type NewKnowledgeStorageRow = typeof knowledgeStorage.$inferInsert
