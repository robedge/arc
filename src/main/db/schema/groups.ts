import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    nameKey: text('name_key').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [uniqueIndex('groups_name_key_unique').on(table.nameKey)]
)

export type GroupRow = typeof groups.$inferSelect
export type NewGroupRow = typeof groups.$inferInsert
