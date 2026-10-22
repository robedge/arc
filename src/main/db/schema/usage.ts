import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex
} from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

export const UsageAgentRole = {
  Brain: 'brain',
  Worker: 'worker',
  Resolver: 'resolver',
  PlanCheck: 'plan_check'
} as const
export type UsageAgentRole = (typeof UsageAgentRole)[keyof typeof UsageAgentRole]

export const UsageSource = { Turn: 'turn', Helper: 'helper', Partial: 'partial' } as const
export type UsageSource = (typeof UsageSource)[keyof typeof UsageSource]

/**
 * Append-only token usage, one row per agent turn or helper message. Usage outlives workers and
 * sessions: `agent_key`/`worker_id` have no FK and the session FK is SET NULL, so the snapshot
 * columns keep the row attributable. `provider` has no CHECK so a new provider needs no migration.
 */
export const usageTurns = sqliteTable(
  'usage_turns',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    agentKey: text('agent_key').notNull(),
    agentRole: text('agent_role').$type<UsageAgentRole>().notNull(),
    workerId: text('worker_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    command: text('command'),
    sessionName: text('session_name'),
    groupId: text('group_id'),
    groupName: text('group_name'),
    workerLabel: text('worker_label'),
    at: integer('at').notNull(),
    /** Local `YYYY-MM-DD`, stored at write time. */
    day: text('day').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    cacheWriteTokens: integer('cache_write_tokens').notNull(),
    cacheReadTokens: integer('cache_read_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    maxCallInput: integer('max_call_input').notNull().default(0),
    callCount: integer('call_count').notNull().default(0),
    contextWindow: integer('context_window'),
    setupTokens: integer('setup_tokens').notNull().default(0),
    arcSetupTokens: integer('arc_setup_tokens').notNull().default(0),
    source: text('source').$type<UsageSource>().notNull().default('turn'),
    /** Idempotency key; unique per agent when set. */
    turnKey: text('turn_key')
  },
  (table) => [
    index('usage_turns_day_idx').on(table.day),
    index('usage_turns_session_agent_idx').on(table.sessionId, table.agentKey),
    index('usage_turns_provider_model_day_idx').on(table.provider, table.model, table.day),
    uniqueIndex('usage_turns_turn_key_uq')
      .on(table.agentKey, table.turnKey)
      .where(sql`${table.turnKey} IS NOT NULL`),
    check(
      'usage_turns_role_check',
      sql`${table.agentRole} IN ('brain','worker','resolver','plan_check')`
    ),
    check('usage_turns_source_check', sql`${table.source} IN ('turn','helper','partial')`),
    check('usage_turns_input_check', sql`${table.inputTokens} >= 0`),
    check('usage_turns_cache_write_check', sql`${table.cacheWriteTokens} >= 0`),
    check('usage_turns_cache_read_check', sql`${table.cacheReadTokens} >= 0`),
    check('usage_turns_output_check', sql`${table.outputTokens} >= 0`)
  ]
)

/**
 * Setup size per (session, agent, provider): Arc's own additions (estimated at agent start/resume)
 * and the total fixed setup (taken once from the first request of a new thread, null until seen).
 */
export const agentSetup = sqliteTable(
  'agent_setup',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    provider: text('provider').notNull(),
    model: text('model'),
    arcAdditionsTokens: integer('arc_additions_tokens').notNull(),
    fixedSetupTokens: integer('fixed_setup_tokens'),
    estimatedAt: integer('estimated_at').notNull()
  },
  (table) => [
    uniqueIndex('agent_setup_session_agent_provider_uq').on(
      table.sessionId,
      table.agentKey,
      table.provider
    )
  ]
)

export const PlanLimitSource = {
  Event: 'event',
  Probe: 'probe',
  Poll: 'poll',
  Push: 'push'
} as const
export type PlanLimitSource = (typeof PlanLimitSource)[keyof typeof PlanLimitSource]

/** Latest observed plan limit per (provider, window). `resets_at` is epoch seconds, `observed_at` epoch ms. */
export const planLimits = sqliteTable(
  'plan_limits',
  {
    provider: text('provider').notNull(),
    window: text('window').notNull(),
    label: text('label').notNull(),
    usedPercent: real('used_percent').notNull(),
    resetsAt: integer('resets_at'),
    observedAt: integer('observed_at').notNull(),
    source: text('source').$type<PlanLimitSource>().notNull(),
    planType: text('plan_type')
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.window] }),
    check('plan_limits_source_check', sql`${table.source} IN ('event','probe','poll','push')`)
  ]
)

/** One row per notice already raised, keyed `provider|window|resetsAt minute|threshold`. */
export const planNotices = sqliteTable(
  'plan_notices',
  {
    key: text('key').primaryKey(),
    provider: text('provider').notNull(),
    window: text('window').notNull(),
    threshold: integer('threshold').notNull(),
    resetsAt: integer('resets_at'),
    notifiedAt: integer('notified_at').notNull(),
    dismissedAt: integer('dismissed_at')
  },
  (table) => [check('plan_notices_threshold_check', sql`${table.threshold} IN (80,95)`)]
)

export const UsageSuggestionKind = {
  ModelTooStrong: 'model_too_strong',
  SetupOverhead: 'setup_overhead',
  RepeatedWork: 'repeated_work',
  LongRunning: 'long_running'
} as const
export type UsageSuggestionKind = (typeof UsageSuggestionKind)[keyof typeof UsageSuggestionKind]

/**
 * One saving suggestion. `dedupe_key` is unique, so a pattern is raised once; a dismissed row is
 * never recreated or changed. `usage_day` is the local `YYYY-MM-DD` it was raised on.
 */
export const usageSuggestions = sqliteTable(
  'usage_suggestions',
  {
    id: text('id').primaryKey(),
    kind: text('kind').$type<UsageSuggestionKind>().notNull(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key'),
    workerId: text('worker_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    text: text('text').notNull(),
    advice: text('advice').notNull(),
    paramsJson: text('params_json').notNull(),
    usageDay: text('usage_day').notNull(),
    createdAt: integer('created_at').notNull(),
    dismissedAt: integer('dismissed_at')
  },
  (table) => [
    index('usage_suggestions_session_idx').on(table.sessionId),
    index('usage_suggestions_dismissed_created_idx').on(table.dismissedAt, table.createdAt),
    check(
      'usage_suggestions_kind_check',
      sql`${table.kind} IN ('model_too_strong','setup_overhead','repeated_work','long_running')`
    )
  ]
)

/** How often an agent read each file in a session; survives restarts because workers resume. */
export const sessionFileReads = sqliteTable(
  'session_file_reads',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    agentKey: text('agent_key').notNull(),
    path: text('path').notNull(),
    readCount: integer('read_count').notNull(),
    lastReadAt: integer('last_read_at').notNull()
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.agentKey, table.path] })]
)
