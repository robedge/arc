import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { groups } from './groups'

export const sections = sqliteTable(
  'sections',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    kind: text('kind', {
      enum: ['projects', 'notes', 'docs', 'playbooks', 'links', 'custom']
    }).notNull(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    folderName: text('folder_name'),
    sortOrder: integer('sort_order').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [
    uniqueIndex('sections_group_name_key_unique').on(table.groupId, table.nameKey),
    uniqueIndex('sections_group_kind_builtin_unique')
      .on(table.groupId, table.kind)
      .where(sql`${table.kind} <> 'custom'`),
    index('sections_group_sort_idx').on(table.groupId, table.sortOrder),
    check(
      'sections_kind_check',
      sql`${table.kind} IN ('projects','notes','docs','playbooks','links','custom')`
    )
  ]
)

export type SectionRow = typeof sections.$inferSelect
export type NewSectionRow = typeof sections.$inferInsert
