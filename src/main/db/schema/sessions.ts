import { PROVIDER_IDS } from '../../../shared/types/provider'
import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique
} from 'drizzle-orm/sqlite-core'
import { groups } from './groups'
import { projects } from './projects'

export const SessionMode = { PlanFirst: 'plan_first', Autonomous: 'autonomous' } as const
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode]

export const SessionStatus = { Active: 'active', Stopped: 'stopped' } as const
export type SessionStatus = (typeof SessionStatus)[keyof typeof SessionStatus]

export const MessageRole = { User: 'user', Brain: 'brain', System: 'system' } as const
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole]

export const MessageState = {
  Streaming: 'streaming',
  Complete: 'complete',
  Stopped: 'stopped'
} as const
export type MessageState = (typeof MessageState)[keyof typeof MessageState]

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Null until the session's branch is named. */
    slug: text('slug'),
    mode: text('mode', { enum: ['plan_first', 'autonomous'] }).notNull(),
    workerLimit: integer('worker_limit').notNull(),
    model: text('model').notNull().default('auto'),
    /** The workers choice as JSON (`WorkersPref`); `model` is the legacy copy and is no longer written. */
    workersPrefJson: text('workers_pref_json').notNull().default('{"mode":"auto"}'),
    /** The brain's requested provider; `brainModel` is the model within it. */
    brainProvider: text('brain_provider', { enum: PROVIDER_IDS }).notNull().default('claude'),
    /** The brain's own model (alias or full id); `model` applies to workers only. */
    brainModel: text('brain_model').notNull().default('sonnet'),
    /** The brain-prompt version the session's brain last knew; below the current one, it gets a one-time update note. */
    brainPromptVersion: integer('brain_prompt_version').notNull().default(0),
    /** Approve every protected request without asking, except pushes and merge/pull requests. */
    autoApprove: integer('auto_approve', { mode: 'boolean' }).notNull().default(false),
    status: text('status', { enum: ['active', 'stopped'] }).notNull(),
    /** Legacy: no longer written (thread ids live in `brain_threads`); kept so a downgrade stays safe. */
    brainClaudeSessionId: text('brain_claude_session_id'),
    /** The folder the brain was first started in; every later launch uses it so the conversation resumes. */
    brainCwd: text('brain_cwd'),
    createdAt: integer('created_at').notNull(),
    lastActiveAt: integer('last_active_at').notNull()
  },
  (table) => [
    index('sessions_group_last_active_idx').on(table.groupId, sql`${table.lastActiveAt} DESC`),
    check('sessions_worker_limit_check', sql`${table.workerLimit} BETWEEN 1 AND 6`)
  ]
)

export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'brain', 'system'] }).notNull(),
    content: text('content').notNull(),
    state: text('state', { enum: ['streaming', 'complete', 'stopped'] }).notNull(),
    /** No FK yet: the plans table arrives in Slice 5, which keeps this column FK-less or rebuilds the table to add SET NULL. */
    planId: text('plan_id'),
    /** A system message with buttons (`{kind:'continue-workers', workerIds, status}`); null for every other message. */
    promptJson: text('prompt_json'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [index('messages_session_id_idx').on(table.sessionId, table.id)]
)

export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    at: integer('at').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    /** No FK yet: the workers table arrives later (spec: SET NULL). */
    workerId: text('worker_id'),
    dataJson: text('data_json')
  },
  (table) => [index('events_session_id_idx').on(table.sessionId, table.id)]
)

export const DirtyHandling = {
  None: 'none',
  Stashed: 'stashed',
  Committed: 'committed',
  Carried: 'carried'
} as const
export type DirtyHandling = (typeof DirtyHandling)[keyof typeof DirtyHandling]

export const SessionProjectMembership = {
  Active: 'active',
  Removed: 'removed',
  LeftOut: 'left_out'
} as const
export type SessionProjectMembership =
  (typeof SessionProjectMembership)[keyof typeof SessionProjectMembership]

/**
 * Surrogate integer PK rather than (session_id, project_id): project_id is nullable (SET NULL keeps
 * the snapshot row when a project is removed) and a PK column cannot be NULL. The unique pair
 * still prevents duplicates; SQLite treats NULLs as distinct, so several orphaned rows can coexist.
 */
export const sessionProjects = sqliteTable(
  'session_projects',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** Null until the session's branch is named. */
    branchName: text('branch_name'),
    baseBranch: text('base_branch'),
    /** The branch the user's checkout was on before the switch (Cancel rollback). */
    previousBranch: text('previous_branch'),
    readOnly: integer('read_only', { mode: 'boolean' }).notNull().default(false),
    dirtyHandling: text('dirty_handling', {
      enum: ['none', 'stashed', 'committed', 'carried']
    })
      .notNull()
      .default('none'),
    stashRef: text('stash_ref'),
    /** Where the session branch started; set once, null for sessions that predate review. */
    baseSha: text('base_sha'),
    /** Latest successful push only; a repush overwrites. History lives in events. */
    pushedRemote: text('pushed_remote'),
    pushedBranch: text('pushed_branch'),
    pushedSha: text('pushed_sha'),
    pushedAt: integer('pushed_at'),
    projectPath: text('project_path').notNull(),
    projectName: text('project_name').notNull(),
    /**
     * `removed`: the project left the group while the session existed (history stays, no new workers);
     * `left_out`: it joined the group later and the user cancelled the unsaved-changes question.
     */
    membership: text('membership', { enum: ['active', 'removed', 'left_out'] })
      .notNull()
      .default('active')
  },
  (table) => [
    unique('session_projects_session_project_unq').on(table.sessionId, table.projectId),
    index('session_projects_project_idx').on(table.projectId)
  ]
)

/** Per-file "Reviewed" ticks in change review. Unticking deletes the row; cascades with the session. */
export const reviewFileMarks = sqliteTable(
  'review_file_marks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionProjectId: integer('session_project_id')
      .notNull()
      .references(() => sessionProjects.id, { onDelete: 'cascade' }),
    /** Exactly as git reports it (case-sensitive). */
    path: text('path').notNull(),
    fingerprint: text('fingerprint').notNull(),
    markedAt: integer('marked_at').notNull()
  },
  (table) => [unique('review_file_marks_project_path_unq').on(table.sessionProjectId, table.path)]
)

export type ReviewFileMarkRow = typeof reviewFileMarks.$inferSelect

/** Line-anchored review notes. Drafts are editable; sending marks them sent with the message id. Cascades with the session. */
export const reviewNotes = sqliteTable(
  'review_notes',
  {
    id: text('id').primaryKey(),
    sessionProjectId: integer('session_project_id')
      .notNull()
      .references(() => sessionProjects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    side: text('side', { enum: ['old', 'new'] }).notNull(),
    line: integer('line').notNull(),
    /** The anchored line's text when the note was written (at most 500 chars). */
    lineText: text('line_text').notNull(),
    body: text('body').notNull(),
    state: text('state', { enum: ['draft', 'sent'] })
      .notNull()
      .default('draft'),
    messageId: integer('message_id').references(() => messages.id, { onDelete: 'set null' }),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [
    index('review_notes_project_path_idx').on(table.sessionProjectId, table.path),
    index('review_notes_drafts_idx')
      .on(table.sessionProjectId)
      .where(sql`${table.state} = 'draft'`),
    check('review_notes_side_check', sql`${table.side} IN ('old','new')`),
    check('review_notes_line_check', sql`${table.line} > 0`),
    check('review_notes_line_text_check', sql`length(${table.lineText}) <= 500`),
    check('review_notes_body_check', sql`length(${table.body}) BETWEEN 1 AND 4000`),
    check('review_notes_state_check', sql`${table.state} IN ('draft','sent')`)
  ]
)

export type ReviewNoteRow = typeof reviewNotes.$inferSelect
export type NewReviewNoteRow = typeof reviewNotes.$inferInsert

/** "Always allow this in this session" rules (functional spec 2.7), derived from an approved request. */
export const sessionAllowRules = sqliteTable(
  'session_allow_rules',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    category: text('category', {
      enum: [
        'outside_worktree',
        'leaves_machine',
        'destructive',
        'global_install',
        'extra_permissions',
        'mcp_write',
        'changes_checkout'
      ]
    }).notNull(),
    tool: text('tool').notNull(),
    /** Normalized command prefix (`git push`); empty for the file tools. */
    prefix: text('prefix').notNull(),
    /** Outside-working-copy rules cover this folder and below. */
    folder: text('folder'),
    /** What the user reads: `git push`, `mkdir in /opt/app`. */
    text: text('text').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => [index('session_allow_rules_session_idx').on(table.sessionId)]
)

export type SessionRow = typeof sessions.$inferSelect
export type NewSessionRow = typeof sessions.$inferInsert
export type MessageRow = typeof messages.$inferSelect
export type NewMessageRow = typeof messages.$inferInsert
export type EventRow = typeof events.$inferSelect
export type NewEventRow = typeof events.$inferInsert
export type SessionProjectRow = typeof sessionProjects.$inferSelect
export type NewSessionProjectRow = typeof sessionProjects.$inferInsert
export type SessionAllowRuleRow = typeof sessionAllowRules.$inferSelect
export type NewSessionAllowRuleRow = typeof sessionAllowRules.$inferInsert

/** The brain's conversation thread per session and provider (Claude session id or Codex thread id). */
export const brainThreads = sqliteTable(
  'brain_threads',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: PROVIDER_IDS }).notNull(),
    threadId: text('thread_id').notNull(),
    updatedAt: integer('updated_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.provider] })]
)
