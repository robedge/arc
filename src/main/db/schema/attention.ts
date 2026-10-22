import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'
import { workers } from './workers'

export const AttentionSource = { Worker: 'worker', Brain: 'brain' } as const
export type AttentionSource = (typeof AttentionSource)[keyof typeof AttentionSource]

export const AttentionKind = { Permission: 'permission', Question: 'question' } as const
export type AttentionKind = (typeof AttentionKind)[keyof typeof AttentionKind]

export const AttentionStatus = {
  Pending: 'pending',
  Approved: 'approved',
  Denied: 'denied',
  Answered: 'answered',
  /** The agent's call died with its process and can never be answered (an AskUserQuestion at restart). */
  Cancelled: 'cancelled'
} as const
export type AttentionStatus = (typeof AttentionStatus)[keyof typeof AttentionStatus]

export const AttentionCategory = {
  OutsideWorktree: 'outside_worktree',
  LeavesMachine: 'leaves_machine',
  Destructive: 'destructive',
  GlobalInstall: 'global_install',
  ExtraPermissions: 'extra_permissions',
  McpWrite: 'mcp_write',
  ChangesCheckout: 'changes_checkout'
} as const
export type AttentionCategory = (typeof AttentionCategory)[keyof typeof AttentionCategory]

/** Where a request is answered: the Needs-attention queue, or the worker's terminal while the user is in control. */
export const AttentionRoute = { Queue: 'queue', Terminal: 'terminal' } as const
export type AttentionRoute = (typeof AttentionRoute)[keyof typeof AttentionRoute]

export const attentionRequests = sqliteTable(
  'attention_requests',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** SET NULL rather than CASCADE: the request is kept as history if only the worker row goes. */
    workerId: text('worker_id').references(() => workers.id, { onDelete: 'set null' }),
    source: text('source', { enum: ['worker', 'brain'] }).notNull(),
    kind: text('kind', { enum: ['permission', 'question'] }).notNull(),
    action: text('action'),
    reason: text('reason'),
    question: text('question'),
    toolName: text('tool_name'),
    /** The original tool input, so an approval can return it as updatedInput. */
    toolInputJson: text('tool_input_json'),
    toolUseId: text('tool_use_id'),
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
    }),
    mustEscalate: integer('must_escalate', { mode: 'boolean' }).notNull().default(false),
    /** True once the request is passed to the user (always true for must-escalate ones). */
    escalated: integer('escalated', { mode: 'boolean' }).notNull().default(false),
    /** The brain's reason for passing the request on. */
    brainNote: text('brain_note'),
    status: text('status', { enum: ['pending', 'approved', 'denied', 'answered', 'cancelled'] })
      .notNull()
      .default('pending'),
    answer: text('answer'),
    /** The answer reached the agent. */
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    route: text('route', { enum: ['queue', 'terminal'] })
      .notNull()
      .default('queue'),
    createdAt: integer('created_at').notNull(),
    resolvedAt: integer('resolved_at')
  },
  (table) => [
    check(
      'attention_requests_content_check',
      sql`${table.action} IS NOT NULL OR ${table.question} IS NOT NULL`
    ),
    index('attention_requests_pending_idx')
      .on(table.sessionId)
      .where(sql`${table.status} = 'pending'`),
    index('attention_requests_status_idx').on(table.status),
    index('attention_requests_worker_idx').on(table.workerId)
  ]
)

export type AttentionRequestRow = typeof attentionRequests.$inferSelect
export type NewAttentionRequestRow = typeof attentionRequests.$inferInsert
