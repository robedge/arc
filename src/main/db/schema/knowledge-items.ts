import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { groups } from './groups'
import { sections } from './sections'

export const knowledgeItems = sqliteTable(
  'knowledge_items',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    relPath: text('rel_path').notNull(),
    kind: text('kind', {
      enum: ['note', 'playbook', 'doc_text', 'doc_binary', 'link', 'item']
    }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    url: text('url'),
    mime: text('mime'),
    sizeBytes: integer('size_bytes').notNull(),
    mtimeMs: integer('mtime_ms').notNull(),
    contentHash: text('content_hash'),
    isEditable: integer('is_editable', { mode: 'boolean' }).notNull(),
    indexedAt: integer('indexed_at').notNull()
  },
  (table) => [
    uniqueIndex('knowledge_items_group_rel_path_unique').on(table.groupId, table.relPath),
    index('knowledge_items_section_idx').on(table.sectionId),
    check(
      'knowledge_items_kind_check',
      sql`${table.kind} IN ('note','playbook','doc_text','doc_binary','link','item')`
    )
  ]
)

export type KnowledgeItemRow = typeof knowledgeItems.$inferSelect
export type NewKnowledgeItemRow = typeof knowledgeItems.$inferInsert
