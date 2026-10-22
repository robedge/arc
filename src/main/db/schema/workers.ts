import { PROVIDER_IDS } from '../../../shared/types/provider'
import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'
import { projects } from './projects'
import { sessions } from './sessions'

export const PlanStatus = {
  Proposed: 'proposed',
  Approved: 'approved',
  Replaced: 'replaced',
  Rejected: 'rejected'
} as const
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus]

export const WorkerStatus = {
  Queued: 'queued',
  Starting: 'starting',
  Working: 'working',
  NeedsApproval: 'needs_approval',
  HasQuestion: 'has_question',
  Done: 'done',
  Merged: 'merged',
  Failed: 'failed',
  Stopped: 'stopped'
} as const
export type WorkerStatus = (typeof WorkerStatus)[keyof typeof WorkerStatus]

export const StoppedBy = { User: 'user', Quit: 'quit', Crash: 'crash' } as const
export type StoppedBy = (typeof StoppedBy)[keyof typeof StoppedBy]

/** The user-control overlay on a worker (`workers.user_control`); null when the user is not in control. */
export const UserControl = { Active: 'active', Paused: 'paused' } as const
export type UserControl = (typeof UserControl)[keyof typeof UserControl]

export const plans = sqliteTable(
  'plans',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['proposed', 'approved', 'replaced', 'rejected'] }).notNull(),
    workersJson: text('workers_json').notNull(),
    /** The brain message carrying the plan card. No FK: messages.plan_id points back here. */
    messageId: integer('message_id'),
    /** The plan that superseded this one. No FK: plans are only deleted with their session. */
    replacedById: text('replaced_by_id'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at')
  },
  (table) => [index('plans_session_idx').on(table.sessionId, table.createdAt)]
)

export const workers = sqliteTable(
  'workers',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    slug: text('slug').notNull(),
    task: text('task').notNull(),
    projectIdsJson: text('project_ids_json').notNull(),
    model: text('model').notNull(),
    status: text('status', {
      enum: [
        'queued',
        'starting',
        'working',
        'needs_approval',
        'has_question',
        'done',
        'merged',
        'failed',
        'stopped'
      ]
    }).notNull(),
    activity: text('activity'),
    failureReason: text('failure_reason'),
    summary: text('summary'),
    /** The provider that actually runs the worker; owns `model` and the session id. */
    provider: text('provider', { enum: PROVIDER_IDS }).notNull().default('claude'),
    /** Set with `fallbackReason` only when the worker fell back; what was asked for. */
    requestedProvider: text('requested_provider', { enum: PROVIDER_IDS }),
    fallbackReason: text('fallback_reason'),
    /** The Claude session id or Codex thread id. */
    providerSessionId: text('provider_session_id'),
    /** No FK: plans are only deleted with their session, which deletes the workers too. */
    planId: text('plan_id'),
    dependsOnJson: text('depends_on_json').notNull().default('[]'),
    stoppedBy: text('stopped_by', { enum: ['user', 'quit', 'crash'] }),
    /** Soft delete (`workers:remove`): the row stays for the event log and merge history; lists skip it. */
    removedAt: integer('removed_at'),
    /** The slash command this worker runs (e.g. `/awos:spec`); null for an ordinary task. */
    command: text('command'),
    /** Control overlay: 'active' (process alive) or 'paused' (no process); status stays as it is. */
    userControl: text('user_control', { enum: ['active', 'paused'] }),
    controlStartedAt: integer('control_started_at'),
    controlUserMessages: integer('control_user_messages').notNull().default(0),
    /** The last line the user typed while in control, cut to 200 characters. */
    controlLastMessage: text('control_last_message'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    unique('workers_session_number_unq').on(table.sessionId, table.number),
    index('workers_session_status_idx').on(table.sessionId, table.status),
    index('workers_status_idx').on(table.status)
  ]
)

/**
 * Surrogate integer PK rather than (worker_id, project_id): project_id is nullable (SET NULL keeps
 * the row when a project is removed) and a PK column cannot be NULL. The unique pair still prevents
 * duplicates; SQLite treats NULLs as distinct, so orphaned rows can coexist. Workers are detached,
 * so there is no branch column.
 */
export const workerWorktrees = sqliteTable(
  'worker_worktrees',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    path: text('path').notNull(),
    baseSha: text('base_sha').notNull(),
    /** Updated after each worker commit. */
    headSha: text('head_sha').notNull(),
    removedAt: integer('removed_at'),
    /** The repository's HEAD when the user stepped in; null when not in control. */
    controlBaseSha: text('control_base_sha')
  },
  (table) => [
    unique('worker_worktrees_worker_project_unq').on(table.workerId, table.projectId),
    index('worker_worktrees_project_idx').on(table.projectId)
  ]
)

/** Brain messages held for a worker while the user is in control; delivered at hand-back. */
export const workerHeldMessages = sqliteTable(
  'worker_held_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    /** Set at hand-back; rows are kept for audit. */
    deliveredAt: integer('delivered_at')
  },
  (table) => [index('worker_held_messages_worker_idx').on(table.workerId, table.deliveredAt)]
)

export const workerCommits = sqliteTable(
  'worker_commits',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    sha: text('sha').notNull(),
    subject: text('subject').notNull(),
    committedAt: integer('committed_at').notNull()
  },
  (table) => [index('worker_commits_worker_idx').on(table.workerId, table.id)]
)

export type PlanRow = typeof plans.$inferSelect
export type NewPlanRow = typeof plans.$inferInsert
export type WorkerRow = typeof workers.$inferSelect
export type NewWorkerRow = typeof workers.$inferInsert
export type WorkerWorktreeRow = typeof workerWorktrees.$inferSelect
export type NewWorkerWorktreeRow = typeof workerWorktrees.$inferInsert
export type WorkerCommitRow = typeof workerCommits.$inferSelect
export type NewWorkerCommitRow = typeof workerCommits.$inferInsert
export type WorkerHeldMessageRow = typeof workerHeldMessages.$inferSelect
export type NewWorkerHeldMessageRow = typeof workerHeldMessages.$inferInsert
