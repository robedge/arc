import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { projects } from './projects'
import { sessions } from './sessions'
import { workers } from './workers'

export const MergeResult = {
  Clean: 'clean',
  Resolved: 'resolved',
  NeedsUser: 'needs_user',
  Failed: 'failed'
} as const
export type MergeResult = (typeof MergeResult)[keyof typeof MergeResult]

export const merges = sqliteTable(
  'merges',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** SET NULL: the merge stays as history if only the worker row goes. */
    workerId: text('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    /** SET NULL: the merge stays as history if the project is removed. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    result: text('result', { enum: ['clean', 'resolved', 'needs_user', 'failed'] }).notNull(),
    filesJson: text('files_json').notNull(),
    conflictFilesJson: text('conflict_files_json'),
    mergeSha: text('merge_sha'),
    notes: text('notes'),
    mergedAt: integer('merged_at').notNull()
  },
  (table) => [
    index('merges_session_idx').on(table.sessionId, table.mergedAt),
    index('merges_worker_idx').on(table.workerId, table.mergedAt)
  ]
)

export type MergeRow = typeof merges.$inferSelect
export type NewMergeRow = typeof merges.$inferInsert
