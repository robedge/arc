import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { sessions, usageSuggestions } from '../schema'
import type { UsageSuggestionKind } from '../schema'
import type { Suggestion, SuggestionKind, UsageRange } from '../../../shared/types/usage'
import { usageRangeDays } from './usage-repo'

export interface UsageSuggestionInput {
  id: string
  kind: UsageSuggestionKind
  sessionId: string
  agentKey?: string | null
  workerId?: string | null
  dedupeKey: string
  text: string
  advice: string
  params: Record<string, unknown>
  usageDay: string
  createdAt: number
}

const kindToShared: Record<UsageSuggestionKind, SuggestionKind> = {
  model_too_strong: 'model-too-strong',
  setup_overhead: 'setup-overhead',
  repeated_work: 'repeated-work',
  long_running: 'long-running'
}

const selection = {
  id: usageSuggestions.id,
  kind: usageSuggestions.kind,
  sessionId: usageSuggestions.sessionId,
  sessionName: sessions.name,
  agentKey: usageSuggestions.agentKey,
  workerId: usageSuggestions.workerId,
  text: usageSuggestions.text,
  advice: usageSuggestions.advice,
  paramsJson: usageSuggestions.paramsJson,
  createdAt: usageSuggestions.createdAt
}

type SelectedRow = {
  id: string
  kind: UsageSuggestionKind
  sessionId: string
  sessionName: string
  agentKey: string | null
  workerId: string | null
  text: string
  advice: string
  paramsJson: string
  createdAt: number
}

function toSuggestion(row: SelectedRow): Suggestion {
  return {
    id: row.id,
    kind: kindToShared[row.kind],
    sessionId: row.sessionId,
    sessionName: row.sessionName,
    ...(row.agentKey === null ? {} : { agentKey: row.agentKey }),
    ...(row.workerId === null ? {} : { workerId: row.workerId }),
    text: row.text,
    advice: row.advice,
    params: JSON.parse(row.paramsJson) as Record<string, unknown>,
    createdAt: row.createdAt
  }
}

/** Saving suggestions, one per `dedupe_key`; a dismissed one is never recreated or changed. */
export class UsageSuggestionsRepo {
  constructor(private readonly db: DbHandle) {}

  /** Inserts, or refreshes text, advice and params of the existing open row with the same key. */
  upsert(s: UsageSuggestionInput): void {
    this.db
      .insert(usageSuggestions)
      .values({
        id: s.id,
        kind: s.kind,
        sessionId: s.sessionId,
        agentKey: s.agentKey ?? null,
        workerId: s.workerId ?? null,
        dedupeKey: s.dedupeKey,
        text: s.text,
        advice: s.advice,
        paramsJson: JSON.stringify(s.params),
        usageDay: s.usageDay,
        createdAt: s.createdAt
      })
      .onConflictDoUpdate({
        target: usageSuggestions.dedupeKey,
        set: {
          text: sql`excluded.text`,
          advice: sql`excluded.advice`,
          paramsJson: sql`excluded.params_json`
        },
        setWhere: isNull(usageSuggestions.dismissedAt)
      })
      .run()
  }

  /** The session a suggestion belongs to. */
  sessionOf(id: string): string | undefined {
    return this.db
      .select({ sessionId: usageSuggestions.sessionId })
      .from(usageSuggestions)
      .where(eq(usageSuggestions.id, id))
      .get()?.sessionId
  }

  dismiss(id: string, now: number): void {
    this.db
      .update(usageSuggestions)
      .set({ dismissedAt: now })
      .where(eq(usageSuggestions.id, id))
      .run()
  }

  /** Undismissed suggestions of a session, newest first. */
  forSession(sessionId: string): Suggestion[] {
    return this.db
      .select(selection)
      .from(usageSuggestions)
      .innerJoin(sessions, eq(sessions.id, usageSuggestions.sessionId))
      .where(and(eq(usageSuggestions.sessionId, sessionId), isNull(usageSuggestions.dismissedAt)))
      .orderBy(desc(usageSuggestions.createdAt), desc(usageSuggestions.id))
      .all()
      .map(toSuggestion)
  }

  /** Undismissed suggestions whose local `usage_day` falls in the range, newest first. */
  listForRange(range: UsageRange, now: number): Suggestion[] {
    const { fromDay, toDay } = usageRangeDays(range, now)
    const conditions = [
      isNull(usageSuggestions.dismissedAt),
      lte(usageSuggestions.usageDay, toDay),
      ...(fromDay === null ? [] : [gte(usageSuggestions.usageDay, fromDay)])
    ]
    return this.db
      .select(selection)
      .from(usageSuggestions)
      .innerJoin(sessions, eq(sessions.id, usageSuggestions.sessionId))
      .where(and(...conditions))
      .orderBy(desc(usageSuggestions.createdAt), desc(usageSuggestions.id))
      .all()
      .map(toSuggestion)
  }
}
