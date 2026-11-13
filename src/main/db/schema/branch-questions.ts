import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sessionProjects, sessions } from './sessions'

export const BranchQuestionStatus = {
  Pending: 'pending',
  Answered: 'answered',
  Cancelled: 'cancelled'
} as const
export type BranchQuestionStatus = (typeof BranchQuestionStatus)[keyof typeof BranchQuestionStatus]

export const BranchQuestionChoice = {
  Stash: 'stash',
  Commit: 'commit',
  Carry: 'carry',
  Skip: 'skip'
} as const
export type BranchQuestionChoice = (typeof BranchQuestionChoice)[keyof typeof BranchQuestionChoice]

/**
 * A question Arc asks the user before it creates the session branch in a repository that has
 * unsaved changes. At most one is open per session project. Arc answers it itself, so it is kept
 * apart from `attention_requests`, whose rows are always an agent's request.
 */
export const branchQuestions = sqliteTable(
  'branch_questions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    sessionProjectId: integer('session_project_id')
      .notNull()
      .references(() => sessionProjects.id, { onDelete: 'cascade' }),
    status: text('status').$type<BranchQuestionStatus>().notNull(),
    choice: text('choice').$type<BranchQuestionChoice>(),
    /** Why "Bring them along" failed; shown on the card when the question is asked again. */
    message: text('message'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at')
  },
  (table) => [
    uniqueIndex('branch_questions_pending_project_unq')
      .on(table.sessionProjectId)
      .where(sql`${table.status} = 'pending'`),
    index('branch_questions_pending_session_idx')
      .on(table.sessionId)
      .where(sql`${table.status} = 'pending'`),
    check(
      'branch_questions_status_check',
      sql`${table.status} IN ('pending','answered','cancelled')`
    ),
    check(
      'branch_questions_choice_check',
      sql`${table.choice} IS NULL OR ${table.choice} IN ('stash','commit','carry','skip')`
    )
  ]
)

export type BranchQuestionRow = typeof branchQuestions.$inferSelect
export type NewBranchQuestionRow = typeof branchQuestions.$inferInsert
