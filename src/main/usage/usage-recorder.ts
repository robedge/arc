import type { AgentEvent, UsageCall } from '../agents/agent-events'
import type { AgentSetupRepo } from '../db/repositories/agent-setup-repo'
import type { GroupsRepo } from '../db/repositories/groups-repo'
import type { SessionsRepo } from '../db/repositories/sessions-repo'
import type { UsageRepo } from '../db/repositories/usage-repo'
import type { WorkerRow, WorkersRepo } from '../db/repositories/workers-repo'
import type { UsageSource } from '../db/schema'
import { isProviderId } from '../../shared/provider-label'
import { providerReportsTokens } from '../../shared/provider-traits'
import type { ProviderId } from '../../shared/types/provider'
import type { AgentUsage, SessionUsage, TokenTotals, UsagePanelRow } from '../../shared/types/usage'
import { usageRecordingState } from '../db/repositories/usage-repo'
import { isResolverRow } from '../sessions/worker-label'
import { normalizeReadPath } from './read-paths'
import type { ReadContext } from './read-paths'
import { bridgeToolDescriptions, estimateSetup } from './setup-estimator'
import type { SuggestionService, WorkerFinished } from './suggestion-service'

/** At most one `usage:session-changed` push per session in this window (trailing edge). */
export const USAGE_PUSH_MS = 1000
/** At most one `usage:changed` push (the Usage page's invalidation) in this window (trailing edge). */
export const USAGE_CHANGED_MS = 5000

type UsageEvent = Extract<AgentEvent, { type: 'usage' }>

export function sumTotals(list: readonly TokenTotals[]): TokenTotals {
  const sum = emptyTotals()
  for (const t of list) {
    sum.input += t.input
    sum.cacheWrite += t.cacheWrite
    sum.cacheRead += t.cacheRead
    sum.output += t.output
    sum.total += t.total
  }
  return sum
}

export function emptyTotals(): TokenTotals {
  return { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0 }
}

/** The `usage_turns.agent_key` of a worker row: its id, or `resolver:<id>` for a merge resolver. */
export function usageAgentKey(row: Pick<WorkerRow, 'id' | 'dependsOnJson'>): string {
  return isResolverRow(row) ? `resolver:${row.id}` : row.id
}

/** Who an event stream belongs to. Provider and model are read at write time (a brain can change them). */
export interface UsageAgent {
  sessionId: string
  /** `brain`, a worker id or `resolver:<id>`. */
  agentKey: string
  role: 'brain' | 'worker' | 'resolver'
  workerId?: string | null
  /** "W2". */
  workerLabel?: string | null
  /** `workers.command` at the time of writing. */
  command?: string | null
  provider: () => ProviderId
  /** The model the agent runs; used when the event does not name one (Codex). */
  model: () => string
  /**
   * Where the agent reads files: its working folder and the checkouts it may see, to turn a path it
   * read into `<repo>/<path>`. Left out, files it reads are not counted.
   */
  readContext?: () => ReadContext
}

/** How one process run of an agent began; decides what the recorder does with setup. */
export interface UsageRun {
  /** True when the run continues an earlier thread (`resume`): its first request is not the fixed setup. */
  resumed: boolean
  /** The full text Arc appends to the agent's system prompt or developer instructions. */
  instructions: string | undefined
}

export interface UsageRecorderDeps {
  repo: Pick<
    UsageRepo,
    'record' | 'sessionTotal' | 'sessionPanel' | 'agentLabels' | 'trackingStartedAt'
  >
  setupRepo: Pick<AgentSetupRepo, 'upsertAdditions' | 'setFixedSetupIfMissing' | 'forSession'>
  sessionsRepo: Pick<SessionsRepo, 'getById'>
  groupsRepo: Pick<GroupsRepo, 'getById'>
  workersRepo: Pick<WorkersRepo, 'listBySession'>
  /** The saving suggestions; left out (tests), none are made and snapshots carry none. */
  suggestions?: Pick<SuggestionService, 'onTurn' | 'onRead' | 'onWorkerFinished' | 'forSession'>
  /** Receives the snapshot for `usage:session-changed`. */
  emit: (usage: SessionUsage) => void
  /** Pushes `usage:changed`; throttled here to once per `changedThrottleMs`. */
  emitChanged?: () => void
  now: () => number
  log?: { warn: (message: string, error?: unknown) => void }
  throttleMs?: number
  changedThrottleMs?: number
}

/** What the launch plan check spent. */
export interface PlanCheckUsage {
  provider: ProviderId
  model: string
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  maxCallInput: number
  callCount: number
  contextWindow?: number | undefined
}

interface Pending {
  turnId: string | undefined
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  maxCallInput: number
  callCount: number
  contextWindow: number | undefined
  model: string | undefined
  partial: boolean
}

/**
 * Folds `usage` events into rows of `usage_turns`: one row per agent turn, written when the turn ends
 * (`turn-result`) or the process exits with usage still unwritten, and one row per Claude helper message.
 * The services above it call `track` once per process run and feed every event of that run to the
 * tracker it returns.
 *
 * `turn_key` is `<runId>:<turnId>` where `runId` is unique per tracker (start time in base 36 plus a
 * counter): a Claude turn id is a per-process sequence ("1", "2", ...) that starts again after a resume,
 * so the process run has to be part of the key. A row written twice for the same run and turn (the
 * recorded flag already prevents it in memory) is ignored by the unique `(agent_key, turn_key)` index.
 * Helper rows use `<runId>:helper:<n>` and late rows `<runId>:<turnId>:late<n>`.
 */
export class UsageRecorder {
  private runCounter = 0
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** Trackers of process runs that have not exited, with their agent: the source of in-flight usage. */
  private readonly live = new Map<UsageTracker, UsageAgent>()
  private changedTimer: NodeJS.Timeout | undefined
  private disposed = false

  constructor(private readonly deps: UsageRecorderDeps) {}

  /**
   * Starts tracking one process run. Arc's additions are estimated and stored right here, before the
   * first event can produce a row, so `record()` sees them. The fixed setup is taken from the
   * `firstCall` of a new thread only.
   */
  track(agent: UsageAgent, run: UsageRun): UsageTracker {
    this.runCounter += 1
    for (const [tracker] of this.live) if (tracker.ended) this.live.delete(tracker)
    const runId = `${this.deps.now().toString(36)}-${this.runCounter}`
    this.recordAdditions(agent, run)
    const tracker: UsageTracker = new UsageTracker(
      runId,
      (turn) => this.write(agent, turn),
      run.resumed
        ? undefined
        : (call) => this.recordFixedSetup(agent, call.input + call.cacheWrite + call.cacheRead),
      agent.readContext === undefined ? undefined : (path) => this.recordRead(agent, path),
      () => this.inFlightChanged(agent),
      () => !providerReportsTokens(agent.provider())
    )
    this.live.set(tracker, agent)
    return tracker
  }

  /** The agent's running turn spent more (or ended): the session's snapshot follows on the push window. */
  private inFlightChanged(agent: UsageAgent): void {
    this.schedulePush(agent.sessionId)
  }

  /** In-flight usage of the session's running turns, per `agent_key`, summed over live trackers. */
  private liveInFlight(sessionId: string): Map<string, { tokens: TokenTotals; agent: UsageAgent }> {
    const out = new Map<string, { tokens: TokenTotals; agent: UsageAgent }>()
    for (const [tracker, agent] of this.live) {
      if (agent.sessionId !== sessionId) continue
      if (tracker.ended) {
        this.live.delete(tracker)
        continue
      }
      const mine = tracker.inFlight()
      if (mine === null) continue
      const held = out.get(agent.agentKey)
      out.set(agent.agentKey, {
        agent,
        tokens: held === undefined ? mine : sumTotals([held.tokens, mine])
      })
    }
    return out
  }

  /** The label the suggestions use for an agent. */
  private labelOf(agent: UsageAgent): string {
    return agent.role === 'brain' ? 'the brain' : (agent.workerLabel ?? agent.agentKey)
  }

  /** A file the agent read: normalized to `<repo>/<path>`, counted, and checked for repeated work. */
  private recordRead(agent: UsageAgent, raw: string): void {
    const suggestions = this.deps.suggestions
    if (suggestions === undefined || agent.readContext === undefined) return
    try {
      suggestions.onRead(
        { sessionId: agent.sessionId, agentKey: agent.agentKey, label: this.labelOf(agent) },
        normalizeReadPath(raw, agent.readContext())
      )
    } catch (error: unknown) {
      this.deps.log?.warn(`could not count a file read by ${agent.agentKey}`, error)
    }
  }

  /** A worker finished (Done): checks whether its model was too strong for the task. */
  workerFinished(input: WorkerFinished): void {
    this.deps.suggestions?.onWorkerFinished(input)
  }

  /** A suggestion was created, refreshed or dismissed: the session's snapshot and the Usage page follow. */
  suggestionsChanged(sessionId: string): void {
    this.schedulePush(sessionId)
    this.scheduleChanged()
  }

  private recordAdditions(agent: UsageAgent, run: UsageRun): void {
    try {
      const estimate = estimateSetup({
        instructions: run.instructions ?? '',
        toolDescriptions: bridgeToolDescriptions(agent.role === 'brain' ? 'brain' : 'worker')
      })
      this.deps.setupRepo.upsertAdditions({
        sessionId: agent.sessionId,
        agentKey: agent.agentKey,
        provider: agent.provider(),
        model: agent.model() || null,
        arcAdditionsTokens: estimate.tokens,
        at: this.deps.now()
      })
    } catch (error: unknown) {
      this.deps.log?.warn(`could not store the setup estimate for ${agent.agentKey}`, error)
    }
  }

  private recordFixedSetup(agent: UsageAgent, tokens: number): void {
    try {
      this.deps.setupRepo.setFixedSetupIfMissing({
        sessionId: agent.sessionId,
        agentKey: agent.agentKey,
        provider: agent.provider(),
        fixedSetupTokens: tokens
      })
    } catch (error: unknown) {
      this.deps.log?.warn(`could not store the fixed setup for ${agent.agentKey}`, error)
    }
  }

  /**
   * Tokens per `agent_key` for the worker cards: null for an agent that was not recorded, zeros for
   * one with no rows yet.
   */
  tokensOf(sessionId: string): (agentKey: string) => TokenTotals | null {
    const tokens = new Map(this.snapshot(sessionId).agents.map((a) => [a.agentKey, a.tokens]))
    return (agentKey) => (tokens.has(agentKey) ? (tokens.get(agentKey) ?? null) : emptyTotals())
  }

  /** Whether the agent is mid-turn with spend not yet saved; its card marks the number as rising. */
  inFlightOf(sessionId: string): (agentKey: string) => boolean {
    const held = this.liveInFlight(sessionId)
    return (agentKey) => held.has(agentKey)
  }

  /**
   * The session's usage. Agents are the brain and every worker or resolver row of the session, plus
   * any agent that only survives in usage rows (a removed worker), so the agents add up to `total`.
   * An agent created before tracking started is `partial` (it has rows) or `not-recorded` (it has
   * none, and `tokens` is null).
   */
  snapshot(sessionId: string, includeInFlight = true): SessionUsage {
    const session = this.deps.sessionsRepo.getById(sessionId)
    const live = includeInFlight
      ? this.liveInFlight(sessionId)
      : new Map<string, { tokens: TokenTotals; agent: UsageAgent }>()
    const panel = this.deps.repo.sessionPanel(sessionId, this.deps.repo.trackingStartedAt())
    const byAgent = new Map<string, UsagePanelRow[]>()
    for (const row of panel.rows) {
      const list = byAgent.get(row.agentKey)
      if (list) list.push(row)
      else byAgent.set(row.agentKey, [row])
    }
    const setupRows = this.deps.setupRepo.forSession(sessionId)
    const build = (
      identity: Pick<AgentUsage, 'agentKey' | 'role' | 'label' | 'provider' | 'model'>,
      createdAt: number | null
    ): AgentUsage => {
      const rows = byAgent.get(identity.agentKey) ?? []
      byAgent.delete(identity.agentKey)
      const inFlight = live.get(identity.agentKey)?.tokens
      const rowTotals = sumTotals(rows.map((r) => r.tokens))
      // Turns were taken on a provider that carries no token counts and nothing was ever counted.
      const unreported =
        inFlight === undefined &&
        rowTotals.total === 0 &&
        rows.some((r) => !providerReportsTokens(r.provider))
      const recording: AgentUsage['recording'] = unreported
        ? 'not-reported'
        : createdAt === null
          ? 'recorded'
          : usageRecordingState(
              createdAt,
              rows.length > 0 || inFlight !== undefined,
              panel.trackingStartedAt
            )
      const saved = recording === 'not-recorded' || recording === 'not-reported' ? null : rowTotals
      const tokens = saved !== null && inFlight !== undefined ? sumTotals([saved, inFlight]) : saved
      const current = setupRows.find(
        (r) => r.agentKey === identity.agentKey && r.provider === identity.provider
      )
      const setupTokens = rows.reduce((sum, r) => sum + r.setupTokens, 0)
      const arcSetupTokens = rows.reduce((sum, r) => sum + r.arcSetupTokens, 0)
      // The setup split is over saved rows: the fixed setup is saved with them.
      const inputTotal = saved === null ? 0 : saved.input + saved.cacheWrite + saved.cacheRead
      return {
        ...identity,
        recording,
        tokens,
        ...(inFlight === undefined ? {} : { inFlight }),
        byModel: rows.map((r) => ({ provider: r.provider, model: r.model, tokens: r.tokens })),
        maxCallInput: rows.reduce((max, r) => Math.max(max, r.maxCallInput), 0),
        setup: {
          // Arc's additions are part of the fixed setup, so the estimate never shows above it.
          arcAdditionsPerRequest:
            current?.arcAdditionsTokens == null
              ? null
              : current.fixedSetupTokens == null
                ? current.arcAdditionsTokens
                : Math.min(current.arcAdditionsTokens, current.fixedSetupTokens),
          fixedSetupPerRequest: current?.fixedSetupTokens ?? null,
          setupTokens,
          arcSetupTokens,
          work: Math.max(0, inputTotal - setupTokens)
        }
      }
    }
    const agents: AgentUsage[] = []
    if (session) {
      agents.push(
        build(
          {
            agentKey: 'brain',
            role: 'brain',
            label: 'Brain',
            provider: session.brainProvider,
            model: session.brainModel
          },
          session.createdAt
        )
      )
    }
    for (const row of this.deps.workersRepo.listBySession(sessionId)) {
      const resolver = isResolverRow(row)
      agents.push(
        build(
          {
            agentKey: usageAgentKey(row),
            role: resolver ? 'resolver' : 'worker',
            label: resolver ? 'Conflict resolver' : `W${row.number} · ${row.slug}`,
            provider: row.provider,
            model: row.model
          },
          row.createdAt
        )
      )
    }
    // Agents that only exist in usage rows: removed workers, and a brain row of a vanished session.
    const labels = this.deps.repo.agentLabels(sessionId)
    for (const [agentKey, rows] of [...byAgent]) {
      const last = rows[rows.length - 1]
      const info = labels.get(agentKey)
      const role = info?.role === 'resolver' || info?.role === 'brain' ? info.role : 'worker'
      agents.push(
        build(
          {
            agentKey,
            role,
            label: role === 'resolver' ? 'Conflict resolver' : (info?.label ?? agentKey),
            provider: isProviderId(last?.provider) ? last.provider : 'claude',
            model: last?.model ?? ''
          },
          null
        )
      )
    }
    const byProvider: SessionUsage['byProvider'] = {}
    const notReported = new Set<ProviderId>()
    for (const row of panel.rows) {
      const provider = isProviderId(row.provider) ? row.provider : 'claude'
      // A provider that reports no tokens has no total: it reads "Not reported" instead of 0.
      if (!providerReportsTokens(provider) && row.tokens.total === 0) {
        if (!(provider in byProvider)) notReported.add(provider)
        continue
      }
      notReported.delete(provider)
      byProvider[provider] = sumTotals([byProvider[provider] ?? emptyTotals(), row.tokens])
    }
    for (const { agent, tokens } of live.values()) {
      const provider = agent.provider()
      notReported.delete(provider)
      byProvider[provider] = sumTotals([byProvider[provider] ?? emptyTotals(), tokens])
    }
    const saved = this.deps.repo.sessionTotal(sessionId)
    const total = sumTotals([saved, ...[...live.values()].map((l) => l.tokens)])
    const setupSum = panel.rows.reduce((sum, r) => sum + r.setupTokens, 0)
    const arcSetupSum = panel.rows.reduce((sum, r) => sum + r.arcSetupTokens, 0)
    return {
      sessionId,
      total,
      setupShare: saved.total > 0 ? setupSum / saved.total : null,
      arcSetupShare: saved.total > 0 ? arcSetupSum / saved.total : null,
      byProvider,
      ...(notReported.size === 0 ? {} : { notReported: [...notReported] }),
      partial: agents.some((a) => a.recording === 'partial'),
      agents,
      suggestions: this.deps.suggestions?.forSession(sessionId) ?? [],
      updatedAt: this.deps.now()
    }
  }

  /**
   * One row for the launch plan check: role `plan_check`, no session, source `turn`. It reaches the
   * repository directly, so no session snapshot is pushed for it. Returns false when it was not stored.
   */
  recordPlanCheck(check: PlanCheckUsage): boolean {
    try {
      const at = this.deps.now()
      const { inserted } = this.deps.repo.record({
        sessionId: null,
        agentKey: 'plan-check',
        agentRole: 'plan_check',
        provider: check.provider,
        model: check.model,
        at,
        inputTokens: check.input,
        cacheWriteTokens: check.cacheWrite,
        cacheReadTokens: check.cacheRead,
        outputTokens: check.output,
        maxCallInput: check.maxCallInput,
        callCount: check.callCount,
        contextWindow: check.contextWindow ?? null,
        source: 'turn',
        turnKey: `plan-check:${at}`
      })
      if (inserted) this.scheduleChanged()
      return inserted
    } catch (error: unknown) {
      this.deps.log?.warn('could not record the plan check usage', error)
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = undefined
  }

  private write(
    agent: UsageAgent,
    turn: { pending: Pending; source: UsageSource; turnKey: string }
  ): boolean {
    const { pending, source, turnKey } = turn
    try {
      const session = this.deps.sessionsRepo.getById(agent.sessionId)
      const group = session ? this.deps.groupsRepo.getById(session.groupId) : undefined
      const result = this.deps.repo.record({
        sessionId: session ? agent.sessionId : null,
        agentKey: agent.agentKey,
        agentRole: agent.role,
        workerId: agent.workerId ?? null,
        provider: agent.provider(),
        model: pending.model ?? agent.model(),
        command: agent.command ?? null,
        sessionName: session?.name ?? null,
        groupId: session?.groupId ?? null,
        groupName: group?.name ?? null,
        workerLabel: agent.workerLabel ?? null,
        at: this.deps.now(),
        inputTokens: pending.input,
        cacheWriteTokens: pending.cacheWrite,
        cacheReadTokens: pending.cacheRead,
        outputTokens: pending.output,
        maxCallInput: pending.maxCallInput,
        callCount: pending.callCount,
        contextWindow: pending.contextWindow ?? null,
        source,
        turnKey
      })
      if (result.inserted) {
        this.schedulePush(agent.sessionId)
        this.scheduleChanged()
        if (session) {
          this.deps.suggestions?.onTurn({
            sessionId: agent.sessionId,
            agentKey: agent.agentKey,
            label: this.labelOf(agent),
            maxCallInput: pending.maxCallInput,
            contextWindow: pending.contextWindow ?? null
          })
        }
      }
      return result.inserted
    } catch (error: unknown) {
      this.deps.log?.warn(`could not record usage for ${agent.agentKey}`, error)
      return false
    }
  }

  /** Trailing edge: the first row of a window starts it; one `usage:changed` goes out when it ends. */
  private scheduleChanged(): void {
    if (this.disposed || this.changedTimer || !this.deps.emitChanged) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = undefined
      if (this.disposed) return
      try {
        this.deps.emitChanged?.()
      } catch (error: unknown) {
        this.deps.log?.warn('could not push usage changed', error)
      }
    }, this.deps.changedThrottleMs ?? USAGE_CHANGED_MS)
    this.changedTimer.unref()
  }

  /** Trailing edge: the first row starts the window, the snapshot is read when it ends. */
  private schedulePush(sessionId: string): void {
    if (this.disposed || this.timers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.timers.delete(sessionId)
      if (this.disposed) return
      try {
        this.deps.emit(this.snapshot(sessionId))
      } catch (error: unknown) {
        this.deps.log?.warn('could not push session usage', error)
      }
    }, this.deps.throttleMs ?? USAGE_PUSH_MS)
    timer.unref()
    this.timers.set(sessionId, timer)
  }
}

/** The events of one process run of one agent. */
export class UsageTracker {
  private readonly pending = new Map<string, Pending>()
  /**
   * Claude's running total of the turn in progress (`usage-progress`), by turn id. A turn's `usage`
   * event (its `result`) takes over from it, and the flush clears it, so nothing counts twice.
   */
  private readonly progress = new Map<string, Pending>()
  /** True once the process run has exited: its in-flight usage is gone. */
  ended = false
  /** Turns already written, with the source of their row (the per-turn recorded flag). */
  private readonly recorded = new Map<string, UsageSource>()
  private helperCount = 0
  private lateCount = 0
  private anonymousCount = 0

  constructor(
    private readonly runId: string,
    private readonly write: (turn: {
      pending: Pending
      source: UsageSource
      turnKey: string
    }) => boolean,
    /** Called with the first request of a new thread; undefined for a resumed run. */
    private readonly onFirstCall?: (call: UsageCall) => void,
    /** Called with the path of each file the agent reads, as the tool reported it. */
    private readonly onRead?: (path: string) => void,
    /** Called when the in-flight usage grew; the recorder pushes a snapshot on its window. */
    private readonly onInFlight?: () => void,
    /** True when the agent's provider reports no tokens: a turn that ends without usage gets a zero row. */
    private readonly reportsNoTokens?: () => boolean
  ) {}

  /**
   * What the turns running now have spent and not yet written, or null when nothing. Held in memory
   * only: a row replaces it when the turn ends, and a crash writes the same partial row as before.
   */
  inFlight(): TokenTotals | null {
    const turns = new Map(this.progress)
    for (const [key, pending] of this.pending) turns.set(key, pending)
    if (turns.size === 0) return null
    const sum = sumTotals(
      [...turns.values()].map((p) => ({
        input: p.input,
        cacheWrite: p.cacheWrite,
        cacheRead: p.cacheRead,
        output: p.output,
        total: p.input + p.cacheWrite + p.cacheRead + p.output
      }))
    )
    return sum.total === 0 ? null : sum
  }

  /** Feeds one event. Returns true when it wrote a row or changed the in-flight usage (the worker's tokens). */
  onEvent(event: AgentEvent): boolean {
    switch (event.type) {
      case 'usage':
        return this.onUsage(event)
      case 'usage-progress':
        return this.onProgress(event)
      case 'turn-result':
        return this.flush(false) || this.recordUnreported(event.turnId)
      case 'exit':
        return this.flush(true)
      case 'tool-use':
        if (event.readPath !== undefined) this.onRead?.(event.readPath)
        return false
      default:
        return false
    }
  }

  private onProgress(event: Extract<AgentEvent, { type: 'usage-progress' }>): boolean {
    // A turn that already has its row (or its final usage event) takes no progress.
    if (this.recorded.has(event.turnId) || this.pending.has(event.turnId)) return false
    this.progress.set(event.turnId, {
      turnId: event.turnId,
      input: event.input,
      cacheWrite: event.cacheWrite,
      cacheRead: event.cacheRead,
      output: event.output,
      maxCallInput: 0,
      callCount: event.callCount,
      contextWindow: undefined,
      model: undefined,
      partial: false
    })
    this.onInFlight?.()
    return true
  }

  private onUsage(event: UsageEvent): boolean {
    if (event.scope === 'helper') {
      this.helperCount += 1
      return this.write({
        pending: { ...fromEvent(event), maxCallInput: 0 },
        source: 'helper',
        turnKey: `${this.runId}:helper:${this.helperCount}`
      })
    }
    // Before any row of this turn is written, so the row's setup columns see it.
    if (event.firstCall !== undefined) this.onFirstCall?.(event.firstCall)
    const key = event.turnId ?? ''
    const done = this.recorded.get(key)
    if (event.turnId !== undefined && done !== undefined) {
      // The turn already has its row. A rebuilt (partial) copy or the real result after a partial row
      // would count it twice; a further update of a Codex turn is new spend and gets its own row.
      if (event.partial || done === 'partial') return false
      this.lateCount += 1
      return this.write({
        pending: fromEvent(event),
        source: 'turn',
        turnKey: `${this.runId}:${key}:late${this.lateCount}`
      })
    }
    const next = fromEvent(event)
    const current = this.pending.get(key)
    this.pending.set(key, current === undefined ? next : merge(current, next))
    // The final figures replace the running total of the same turn (Claude).
    this.progress.delete(key)
    this.onInFlight?.()
    return true
  }

  /**
   * A turn of a provider that reports no tokens ended with no usage: one row of zeros, so the turn
   * counts and the agent reads "Not reported" instead of looking like it never ran.
   */
  private recordUnreported(turnId: string | undefined): boolean {
    if (this.reportsNoTokens?.() !== true) return false
    const key = turnId ?? ''
    if (turnId !== undefined && this.recorded.has(key)) return false
    this.anonymousCount += turnId === undefined ? 1 : 0
    const turnKey =
      turnId === undefined ? `${this.runId}:n${this.anonymousCount}` : `${this.runId}:${turnId}`
    if (turnId !== undefined) this.recorded.set(key, 'turn')
    return this.write({
      pending: {
        turnId,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        maxCallInput: 0,
        callCount: 0,
        contextWindow: undefined,
        model: undefined,
        partial: false
      },
      source: 'turn',
      turnKey
    })
  }

  /** Writes every turn with unwritten usage. On exit the figures are a lower bound, so the row is `partial`. */
  private flush(onExit: boolean): boolean {
    let wrote = false
    // Taken out first, so a snapshot read while the rows are written never counts a turn twice.
    const turns = [...this.pending]
    const hadInFlight = this.inFlight() !== null
    this.pending.clear()
    this.progress.clear()
    if (onExit) this.ended = true
    for (const [key, pending] of turns) {
      const source: UsageSource = onExit || pending.partial ? 'partial' : 'turn'
      let turnKey: string
      if (pending.turnId === undefined) {
        this.anonymousCount += 1
        turnKey = `${this.runId}:n${this.anonymousCount}`
      } else {
        turnKey = `${this.runId}:${pending.turnId}`
        this.recorded.set(key, source)
      }
      if (this.write({ pending, source, turnKey })) wrote = true
    }
    // A figure that was shown and is now gone without a row (a crash mid-turn) still needs a push.
    if (hadInFlight && !wrote) this.onInFlight?.()
    return wrote || hadInFlight
  }
}

function fromEvent(event: UsageEvent): Pending {
  return {
    turnId: event.turnId,
    input: event.input,
    cacheWrite: event.cacheWrite,
    cacheRead: event.cacheRead,
    output: event.output,
    maxCallInput: event.maxCallInput,
    callCount: event.callCount,
    contextWindow: event.contextWindow,
    model: event.model,
    partial: event.partial
  }
}

/** Sums the buckets and call counts, takes the largest request, and keeps the last window and model seen. */
function merge(a: Pending, b: Pending): Pending {
  return {
    turnId: a.turnId,
    input: a.input + b.input,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
    maxCallInput: Math.max(a.maxCallInput, b.maxCallInput),
    callCount: a.callCount + b.callCount,
    contextWindow: b.contextWindow ?? a.contextWindow,
    model: b.model ?? a.model,
    partial: a.partial || b.partial
  }
}
