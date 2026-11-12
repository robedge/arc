import { sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sessions } from './sessions'

export const KnowledgeSuggestionAction = { New: 'new', Update: 'update' } as const
export type KnowledgeSuggestionAction =
  (typeof KnowledgeSuggestionAction)[keyof typeof KnowledgeSuggestionAction]

export const KnowledgeSuggestionStatus = {
  Waiting: 'waiting',
  Accepted: 'accepted',
  AcceptedEdited: 'accepted_edited',
  Discarded: 'discarded'
} as const
export type KnowledgeSuggestionStatus =
  (typeof KnowledgeSuggestionStatus)[keyof typeof KnowledgeSuggestionStatus]

/**
 * One knowledge suggestion made by a session's brain. `group_id`, `section_id` and the target path
 * are plain values with no foreign keys: items are dropped and re-created when files change outside
 * Arc, and a waiting suggestion must survive that. Resolved rows are kept so `dedupe_key` (unique
 * across every status) keeps blocking repeats; they go with the session.
 */
export const knowledgeSuggestions = sqliteTable(
  'knowledge_suggestions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    groupId: text('group_id').notNull(),
    /** Id of the user message the suggestion belongs to (for the per-request cap). */
    requestId: text('request_id').notNull(),
    action: text('action').$type<KnowledgeSuggestionAction>().notNull(),
    title: text('title').notNull(),
    reason: text('reason').notNull(),
    sectionId: text('section_id').notNull(),
    sectionName: text('section_name').notNull(),
    targetRelPath: text('target_rel_path'),
    proposedName: text('proposed_name'),
    proposedContent: text('proposed_content').notNull(),
    hunksJson: text('hunks_json'),
    baseRevision: text('base_revision'),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').$type<KnowledgeSuggestionStatus>().notNull().default('waiting'),
    editedContent: text('edited_content'),
    createdAt: integer('created_at').notNull(),
    /** Null exactly while `waiting`. */
    resolvedAt: integer('resolved_at')
  },
  (table) => [
    uniqueIndex('knowledge_suggestions_dedupe_key_uq').on(table.dedupeKey),
    index('knowledge_suggestions_waiting_idx')
      .on(table.sessionId, table.createdAt)
      .where(sql`${table.status} = 'waiting'`),
    index('knowledge_suggestions_request_idx').on(table.sessionId, table.requestId),
    check('knowledge_suggestions_action_check', sql`${table.action} IN ('new','update')`),
    check(
      'knowledge_suggestions_status_check',
      sql`${table.status} IN ('waiting','accepted','accepted_edited','discarded')`
    ),
    check(
      'knowledge_suggestions_target_check',
      sql`(${table.action} = 'new' AND ${table.proposedName} IS NOT NULL) OR (${table.action} = 'update' AND ${table.targetRelPath} IS NOT NULL)`
    ),
    check(
      'knowledge_suggestions_resolved_check',
      sql`(${table.status} = 'waiting') = (${table.resolvedAt} IS NULL)`
    )
  ]
)
