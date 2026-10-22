import { and, eq, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { providerReportsTokens } from '../../../shared/provider-traits'
import { agentSetup, appSettings, usageTurns } from '../schema'
import type { UsageAgentRole, UsageSource } from '../schema'
import type {
  DailyUsage,
  RangeTotals,
  SpenderKind,
  SpenderRow,
  TokenTotals,
  UsagePanelRow,
  UsageRange,
  UsageRecordingState
} from '../../../shared/types/usage'

/** One agent turn (or helper message) to record. `day` is derived from `at`. */
export interface UsageTurnInput {
  sessionId: string | null
  agentKey: string
  agentRole: UsageAgentRole
  workerId?: string | null
  provider: string
  model: string
  command?: string | null
  sessionName?: string | null
  groupId?: string | null
  groupName?: string | null
  workerLabel?: string | null
  at: number
  inputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  outputTokens: number
  maxCallInput?: number
  callCount?: number
  contextWindow?: number | null
  source?: UsageSource
  turnKey?: string | null
}

/** The local-time `YYYY-MM-DD` for an epoch-ms instant. */
export function localDay(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * The inclusive local-day window of a range ending at `now`: today = today; 7d = today and the 6
 * days before; 30d = today and the 29 before. `all` has no lower bound (`fromDay` null).
 */
export function usageRangeDays(
  range: UsageRange,
  now: number
): { fromDay: string | null; toDay: string } {
  const today = new Date(now)
  const toDay = formatDay(today)
  const back = range === 'today' ? 0 : range === '7d' ? 6 : range === '30d' ? 29 : null
  if (back === null) return { fromDay: null, toDay }
  return {
    fromDay: formatDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)),
    toDay
  }
}

function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    total: a.total + b.total
  }
}

interface TotalsRow {
  input: number | null
  cacheWrite: number | null
  cacheRead: number | null
  output: number | null
}

function toTotals(row: TotalsRow | undefined): TokenTotals {
  const input = row?.input ?? 0
  const cacheWrite = row?.cacheWrite ?? 0
  const cacheRead = row?.cacheRead ?? 0
  const output = row?.output ?? 0
  return { input, cacheWrite, cacheRead, output, total: input + cacheWrite + cacheRead + output }
}

const sums = {
  input: sql<number | null>`SUM(${usageTurns.inputTokens})`,
  cacheWrite: sql<number | null>`SUM(${usageTurns.cacheWriteTokens})`,
  cacheRead: sql<number | null>`SUM(${usageTurns.cacheReadTokens})`,
  output: sql<number | null>`SUM(${usageTurns.outputTokens})`
}

export const TRACKING_STARTED_KEY = 'usage.trackingStartedAt'

/**
 * The "Not recorded" rules. An agent created at or after tracking started is fully recorded (no
 * rows means zeros). One created earlier with no rows is not recorded; with rows it is partial
 * ("since Arc started recording"). Without a tracking start, nothing is known to be missing.
 */
export function usageRecordingState(
  agentCreatedAt: number,
  hasRows: boolean,
  trackingStartedAt: number | null
): UsageRecordingState {
  if (trackingStartedAt === null || agentCreatedAt >= trackingStartedAt) return 'recorded'
  return hasRows ? 'partial' : 'not-recorded'
}

/** Append-only token usage per agent turn. */
export class UsageRepo {
  constructor(private readonly db: DbHandle) {}

  /**
   * The setup columns stored with a turn. With turnInput = input + cacheWrite + cacheRead and the
   * agent's `agent_setup` row for (session, agent, provider):
   * - fixed setup known: setup = min(turnInput, fixed x callCount);
   *   arcSetup = min(setup, additions x callCount);
   * - fixed setup unknown: setup = 0; arcSetup = min(turnInput, additions x callCount);
   * - helper rows and rows without a session: 0 for both.
   * Computed at write time so shares do not shift when an estimate is refreshed later.
   */
  private setupColumns(turn: UsageTurnInput): { setup: number; arcSetup: number } {
    if (turn.source === 'helper' || turn.sessionId === null) return { setup: 0, arcSetup: 0 }
    const row = this.db
      .select()
      .from(agentSetup)
      .where(
        and(
          eq(agentSetup.sessionId, turn.sessionId),
          eq(agentSetup.agentKey, turn.agentKey),
          eq(agentSetup.provider, turn.provider)
        )
      )
      .get()
    if (!row) return { setup: 0, arcSetup: 0 }
    const callCount = turn.callCount ?? 0
    const turnInput = turn.inputTokens + turn.cacheWriteTokens + turn.cacheReadTokens
    const additions = row.arcAdditionsTokens * callCount
    if (row.fixedSetupTokens === null) return { setup: 0, arcSetup: Math.min(turnInput, additions) }
    const setup = Math.min(turnInput, row.fixedSetupTokens * callCount)
    return { setup, arcSetup: Math.min(setup, additions) }
  }

  /** Inserts the turn; a repeated `(agentKey, turnKey)` is ignored and reported as not inserted. */
  record(turn: UsageTurnInput): { inserted: boolean } {
    const { setup, arcSetup } = this.setupColumns(turn)
    const result = this.db
      .insert(usageTurns)
      .values({
        sessionId: turn.sessionId,
        agentKey: turn.agentKey,
        agentRole: turn.agentRole,
        workerId: turn.workerId ?? null,
        provider: turn.provider,
        model: turn.model,
        command: turn.command ?? null,
        sessionName: turn.sessionName ?? null,
        groupId: turn.groupId ?? null,
        groupName: turn.groupName ?? null,
        workerLabel: turn.workerLabel ?? null,
        at: turn.at,
        day: localDay(turn.at),
        inputTokens: turn.inputTokens,
        cacheWriteTokens: turn.cacheWriteTokens,
        cacheReadTokens: turn.cacheReadTokens,
        outputTokens: turn.outputTokens,
        maxCallInput: turn.maxCallInput ?? 0,
        callCount: turn.callCount ?? 0,
        contextWindow: turn.contextWindow ?? null,
        setupTokens: setup,
        arcSetupTokens: arcSetup,
        source: turn.source ?? 'turn',
        turnKey: turn.turnKey ?? null
      })
      .onConflictDoNothing()
      .run()
    return { inserted: result.changes > 0 }
  }

  sessionTotal(sessionId: string): TokenTotals {
    return toTotals(
      this.db.select(sums).from(usageTurns).where(eq(usageTurns.sessionId, sessionId)).get()
    )
  }

  /** Totals per `agent_key` (`brain`, a worker id, `resolver:<id>`) for one session. */
  workerTotals(sessionId: string): Map<string, TokenTotals> {
    const rows = this.db
      .select({ agentKey: usageTurns.agentKey, ...sums })
      .from(usageTurns)
      .where(eq(usageTurns.sessionId, sessionId))
      .groupBy(usageTurns.agentKey)
      .all()
    return new Map(rows.map((r) => [r.agentKey, toTotals(r)]))
  }

  /**
   * The role and last recorded worker label ("W2") per `agent_key` of one session, for agents that
   * no longer exist as workers.
   */
  agentLabels(sessionId: string): Map<string, { role: UsageAgentRole; label: string | null }> {
    const rows = this.db
      .select({
        agentKey: usageTurns.agentKey,
        role: sql<UsageAgentRole>`MAX(${usageTurns.agentRole})`,
        label: sql<string | null>`MAX(${usageTurns.workerLabel})`
      })
      .from(usageTurns)
      .where(eq(usageTurns.sessionId, sessionId))
      .groupBy(usageTurns.agentKey)
      .all()
    return new Map(rows.map((r) => [r.agentKey, { role: r.role, label: r.label }]))
  }

  /** `usage.trackingStartedAt` (epoch ms), or null when missing or unreadable. */
  trackingStartedAt(): number | null {
    const row = this.db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, TRACKING_STARTED_KEY))
      .get()
    if (!row) return null
    try {
      const value: unknown = JSON.parse(row.valueJson)
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    } catch {
      return null
    }
  }

  /**
   * Per-agent rows for one session, grouped by agent, provider and model, plus the tracking start
   * the caller feeds to `usageRecordingState`. Uses the (session_id, agent_key) index.
   */
  sessionPanel(
    sessionId: string,
    trackingStartedAt: number | null
  ): { trackingStartedAt: number | null; rows: UsagePanelRow[] } {
    const rows = this.db
      .select({
        agentKey: usageTurns.agentKey,
        provider: usageTurns.provider,
        model: usageTurns.model,
        ...sums,
        maxCallInput: sql<number>`MAX(${usageTurns.maxCallInput})`,
        setupTokens: sql<number>`SUM(${usageTurns.setupTokens})`,
        arcSetupTokens: sql<number>`SUM(${usageTurns.arcSetupTokens})`,
        rowCount: sql<number>`COUNT(*)`
      })
      .from(usageTurns)
      .where(eq(usageTurns.sessionId, sessionId))
      .groupBy(usageTurns.agentKey, usageTurns.provider, usageTurns.model)
      .orderBy(usageTurns.agentKey, usageTurns.provider, usageTurns.model)
      .all()
    return {
      trackingStartedAt,
      rows: rows.map((r) => ({
        agentKey: r.agentKey,
        provider: r.provider,
        model: r.model,
        tokens: toTotals(r),
        maxCallInput: r.maxCallInput,
        setupTokens: r.setupTokens,
        arcSetupTokens: r.arcSetupTokens,
        rowCount: r.rowCount
      }))
    }
  }

  private dayFilter(range: UsageRange, now: number): ReturnType<typeof sql> {
    const { fromDay, toDay } = usageRangeDays(range, now)
    return fromDay === null
      ? sql`${usageTurns.day} <= ${toDay}`
      : sql`${usageTurns.day} >= ${fromDay} AND ${usageTurns.day} <= ${toDay}`
  }

  /** Totals for a range, plan check included, plus the plan check's own share. */
  rangeTotals(range: UsageRange, now: number): RangeTotals {
    const rows = this.db
      .select({
        provider: usageTurns.provider,
        model: usageTurns.model,
        planCheck: sql<number>`${usageTurns.agentRole} = 'plan_check'`,
        ...sums
      })
      .from(usageTurns)
      .where(this.dayFilter(range, now))
      .groupBy(usageTurns.provider, usageTurns.model, sql`${usageTurns.agentRole} = 'plan_check'`)
      .all()
    const zero = toTotals(undefined)
    let total = zero
    let planCheck = zero
    const providers = new Map<string, TokenTotals>()
    const models = new Map<string, { provider: string; model: string; tokens: TokenTotals }>()
    for (const r of rows) {
      const t = toTotals(r)
      total = addTotals(total, t)
      if (r.planCheck) planCheck = addTotals(planCheck, t)
      providers.set(r.provider, addTotals(providers.get(r.provider) ?? zero, t))
      const k = `${r.provider}\u0000${r.model}`
      const prev = models.get(k)
      models.set(k, {
        provider: r.provider,
        model: r.model,
        tokens: addTotals(prev?.tokens ?? zero, t)
      })
    }
    const byTokens = <T extends { tokens: TokenTotals }>(a: T, b: T): number =>
      b.tokens.total - a.tokens.total
    return {
      total,
      byProvider: [...providers]
        .map(([provider, tokens]) => ({
          provider,
          tokens,
          // Turns that carry no tokens because the provider reports none (Cursor): "Not reported".
          ...(!providerReportsTokens(provider) && tokens.total === 0
            ? { notReported: true as const }
            : {})
        }))
        .sort(byTokens),
      byModel: [...models.values()].sort(byTokens),
      planCheck
    }
  }

  /**
   * One entry per local day with total tokens per provider; days without usage are present and
   * empty. `all` starts at the earliest usage day; no usage at all gives an empty array.
   */
  dailyByProvider(range: UsageRange, now: number): DailyUsage[] {
    const { fromDay, toDay } = usageRangeDays(range, now)
    const rows = this.db
      .select({
        day: usageTurns.day,
        provider: usageTurns.provider,
        tokens: sql<number>`SUM(${usageTurns.inputTokens} + ${usageTurns.cacheWriteTokens} + ${usageTurns.cacheReadTokens} + ${usageTurns.outputTokens})`
      })
      .from(usageTurns)
      .where(this.dayFilter(range, now))
      .groupBy(usageTurns.day, usageTurns.provider)
      .all()
    const byDay = new Map<string, Record<string, number>>()
    for (const r of rows) {
      const entry = byDay.get(r.day) ?? {}
      entry[r.provider] = r.tokens
      byDay.set(r.day, entry)
    }
    const start = fromDay ?? [...byDay.keys()].sort()[0]
    if (start === undefined) return []
    const [y, m, d] = start.split('-').map(Number) as [number, number, number]
    const out: DailyUsage[] = []
    for (let i = 0; ; i++) {
      const day = formatDay(new Date(y, m - 1, d + i))
      if (day > toDay) break
      out.push({ day, byProvider: byDay.get(day) ?? {} })
    }
    return out
  }

  /** The top `limit` sessions, workers or commands by total tokens. The plan check is excluded. */
  biggestSpenders(range: UsageRange, by: SpenderKind, limit: number, now: number): SpenderRow[] {
    const u = usageTurns
    const deletedSession = sql`'deleted:' || COALESCE(${u.sessionName}, '')`
    const sessionKey = sql`COALESCE(${u.sessionId}, ${deletedSession})`
    const sessionName = sql`COALESCE(s.name, ${u.sessionName}, 'Deleted session')`
    const groupName = sql`COALESCE(g.name, ${u.groupName})`
    const key =
      by === 'session'
        ? sessionKey
        : by === 'worker'
          ? sql`${sessionKey} || '|' || ${u.agentKey}`
          : sql`${u.command}`
    const kindFilter =
      by === 'worker'
        ? sql`${u.agentRole} IN ('worker','resolver')`
        : by === 'command'
          ? sql`${u.command} IS NOT NULL`
          : sql`1 = 1`
    const where = sql`${this.dayFilter(range, now)} AND ${u.agentRole} <> 'plan_check' AND ${kindFilter}`
    const from = sql`FROM usage_turns ${u} LEFT JOIN sessions s ON s.id = ${u.sessionId} LEFT JOIN groups g ON g.id = s.group_id`

    interface PairRow {
      key: string
      provider: string
      model: string
      total: number
      name: string | null
      label: string | null
      sessionId: string | null
      workerId: string | null
      groupName: string | null
    }
    const pairs = this.db.all<PairRow>(sql`
      SELECT ${key} AS key, ${u.provider} AS provider, ${u.model} AS model,
        SUM(${u.inputTokens} + ${u.cacheWriteTokens} + ${u.cacheReadTokens} + ${u.outputTokens}) AS total,
        MAX(${sessionName}) AS name, MAX(${u.workerLabel}) AS label,
        MAX(${u.sessionId}) AS sessionId, MAX(${u.workerId}) AS workerId,
        MAX(${groupName}) AS groupName
      ${from} WHERE ${where}
      GROUP BY ${key}, ${u.provider}, ${u.model}`)

    const merged = new Map<string, SpenderRow & { pairs: PairRow[] }>()
    for (const p of pairs) {
      const prev = merged.get(p.key)
      if (prev) {
        prev.total += p.total
        prev.pairs.push(p)
        continue
      }
      const name =
        by === 'command'
          ? p.key
          : by === 'worker'
            ? `${p.label ?? 'Worker'} · ${p.name ?? ''}`
            : (p.name ?? '')
      const row: SpenderRow & { pairs: PairRow[] } = {
        key: p.key,
        name,
        groupName: p.groupName,
        provider: p.provider,
        model: p.model,
        total: p.total,
        clickable: by !== 'command' && p.sessionId !== null,
        pairs: [p]
      }
      if (by !== 'command' && p.sessionId !== null) row.sessionId = p.sessionId
      if (by === 'worker' && p.workerId !== null) row.workerId = p.workerId
      merged.set(p.key, row)
    }
    const ranked = [...merged.values()]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, limit)

    const commandStats = new Map<string, { runs: number; groups: number }>()
    if (by === 'command') {
      const stats = this.db.all<{ key: string; runs: number; groups: number }>(sql`
        SELECT ${key} AS key,
          COUNT(DISTINCT COALESCE(${u.sessionId}, '') || '|' || ${u.agentKey}) AS runs,
          COUNT(DISTINCT ${groupName}) AS groups
        ${from} WHERE ${where} GROUP BY ${key}`)
      for (const s of stats) commandStats.set(s.key, { runs: s.runs, groups: s.groups })
    }

    return ranked.map(({ pairs: ps, ...row }) => {
      if (ps.length > 1) {
        row.provider = ps.every((p) => p.provider === ps[0]!.provider) ? ps[0]!.provider : 'Mixed'
        row.model = 'Mixed'
      }
      if (by === 'command') {
        const st = commandStats.get(row.key)
        row.runs = st?.runs ?? 0
        if (st && st.groups > 1) row.groupName = `${st.groups} groups`
      }
      return row
    })
  }
}
