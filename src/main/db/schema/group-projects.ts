import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { groups } from './groups'
import { projects } from './projects'

export const groupProjects = sqliteTable(
  'group_projects',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull(),
    addedAt: integer('added_at').notNull()
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.projectId] }),
    index('group_projects_project_idx').on(table.projectId)
  ]
)

export type GroupProjectRow = typeof groupProjects.$inferSelect
export type NewGroupProjectRow = typeof groupProjects.$inferInsert
