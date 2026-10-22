import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  /** Canonical form is produced by the service, not here. */
  path: text('path').notNull().unique(),
  displayName: text('display_name').notNull(),
  isGit: integer('is_git', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: integer('last_seen_at'),
  createdAt: integer('created_at').notNull()
})

export type ProjectRow = typeof projects.$inferSelect
export type NewProjectRow = typeof projects.$inferInsert
