import type { ProviderId } from './provider'

/** Token buckets for one agent, a session or a range. `total` is the sum of the four buckets. */
export interface TokenTotals {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
  total: number
}

/** Whether an agent's usage is complete, partial or missing, judged against `usage.trackingStartedAt`. */
export type UsageRecordingState = 'recorded' | 'partial' | 'not-recorded' | 'not-reported'

/** One agent's tokens under one provider and model. */
export interface AgentModelUsage {
  provider: string
  model: string
  tokens: TokenTotals
}

/** One agent's usage in a session snapshot. */
export interface AgentUsage {
  /** `brain`, the worker id, or `resolver:<worker id>`. The worker id matches `WorkerView.id`. */
  agentKey: string
  role: 'brain' | 'worker' | 'resolver'
  /** "Brain", "W2 · docs-update" or "Conflict resolver"; for a removed worker, its recorded label. */
  label: string
  /** The agent's current provider and model (the last recorded ones for a removed worker). */
  provider: ProviderId
  model: string
  /**
   * `recorded`: complete. `partial`: created before tracking started, counted only since then.
   * `not-recorded`: created before tracking started and nothing was recorded.
   * `not-reported`: the agent's provider carries no token counts (Cursor) and its turns ended without
   * any: not Arc's miss, the provider's. Such an agent is left out of every token total.
   */
  recording: UsageRecordingState
  /**
   * Null exactly when `recording` is `not-recorded` ("Not recorded") or `not-reported` ("Not reported"). Zeros before the first row. While
   * the agent is mid-turn it includes `inFlight`, so it rises with every request.
   */
  tokens: TokenTotals | null
  /**
   * What the agent has spent in the turn it is running, not yet written as a row (already inside
   * `tokens`). Present only while that turn runs and has spent something; main process memory, never stored.
   */
  inFlight?: TokenTotals
  /** The agent's tokens per provider and model (a brain can span models after a provider switch). */
  byModel: AgentModelUsage[]
  /** Largest single-request input seen for the agent; 0 without rows. */
  maxCallInput: number
  /** Where the agent's input went: setup (Arc's additions inside the fixed setup) and the work. */
  setup: AgentSetup
}

/** One agent's setup split. Fixed setup in all (`setupTokens`) plus `work` equals its input total. */
export interface AgentSetup {
  /** Arc's estimated additions per request, for the agent's current provider; null if never estimated. */
  arcAdditionsPerRequest: number | null
  /** Measured first request of a new thread, per request; null until known. */
  fixedSetupPerRequest: number | null
  /** Summed `setup_tokens` over the agent's rows: the fixed setup in all. */
  setupTokens: number
  /** Summed `arc_setup_tokens`: the part of the setup that is Arc's additions. */
  arcSetupTokens: number
  /** `max(0, input + cacheWrite + cacheRead - setupTokens)`. */
  work: number
}

/**
 * `usage:get-session` and the `usage:session-changed` push. `total` counts every recorded row of the
 * session, including those of removed workers, plus the in-flight usage of the running turns, so it
 * equals the sum of `agents[].tokens`. The shares, `byModel` and `setup` are over saved rows only, as
 * are the suggestions and the Usage page.
 */
export interface SessionUsage {
  sessionId: string
  total: TokenTotals
  /** SUM(setup tokens) / saved total tokens; null when nothing is recorded. */
  setupShare: number | null
  /** SUM(Arc's additions within setup) / total tokens; null when nothing is recorded. */
  arcSetupShare: number | null
  /** Totals per provider, only providers with usage. A provider listed in `notReported` is not in it. */
  byProvider: Partial<Record<ProviderId, TokenTotals>>
  /**
   * Providers that took turns in this session without reporting tokens (Cursor today): their rows read
   * "Not reported" and they are left out of `total` and `byProvider`. Omitted when none.
   */
  notReported?: ProviderId[]
  /** True when any agent is `partial`. */
  partial: boolean
  agents: AgentUsage[]
  /** The session's undismissed suggestions, newest first. */
  suggestions: Suggestion[]
  updatedAt: number
}

/** One agent's usage rows grouped by provider and model, as read for the session panel. */
export interface UsagePanelRow {
  agentKey: string
  provider: string
  model: string
  tokens: TokenTotals
  /** Largest single-request input seen in any of the grouped rows. */
  maxCallInput: number
  /** Summed `setup_tokens` of the grouped rows. */
  setupTokens: number
  /** Summed `arc_setup_tokens` of the grouped rows. */
  arcSetupTokens: number
  /** Number of usage rows (turns and helper messages) in the group. */
  rowCount: number
}

/** The latest observation of one plan limit window. `resetsAt` is epoch seconds, `observedAt` epoch ms. */
export interface PlanLimit {
  provider: string
  windowId: string
  label: string
  usedPercent: number
  resetsAt: number | null
  observedAt: number
  source: 'event' | 'probe' | 'poll' | 'push'
  /**
   * Set on the way out (`plan:get`, `plan:changed`), never stored: the window's `resetsAt` has passed,
   * so `usedPercent` belongs to the period that ended. The UI shows "Reset", not the old percentage.
   */
  stale?: boolean
}

/**
 * What a provider's meter shows: `waiting` (no observation yet), `ok` (limits known), `not-reported`
 * (the provider answered with no windows) or `stale` (every known window has reset since it was seen).
 */
export type PlanMeterState = 'waiting' | 'ok' | 'not-reported' | 'stale'

/** One provider's meter. Only providers that are set up appear. */
export interface ProviderPlan {
  provider: ProviderId
  state: PlanMeterState
  /** Latest observation per window, shortest window first. Empty for `waiting` and `not-reported`. */
  limits: PlanLimit[]
  planType?: string
}

/** A one-time notice that a plan limit window crossed a threshold. */
export interface PlanNotice {
  key: string
  provider: string
  windowId: string
  label?: string
  threshold: 80 | 95
  usedPercent?: number
  resetsAt: number | null
}

/** What `plan:get` and `plan:refresh` answer and `plan:changed` pushes. */
export interface PlanSnapshot {
  plans: ProviderPlan[]
  notices: PlanNotice[]
}

/** The Usage page's range. */
export type UsageRange = 'today' | '7d' | '30d' | 'all'

/** What the Biggest spenders list ranks. */
export type SpenderKind = 'session' | 'worker' | 'command'

/** Totals for a range. `total` and the breakdowns include the plan check; `planCheck` is its own share. */
export interface RangeTotals {
  total: TokenTotals
  /** Providers with turns in the range and no tokens at all because they report none: "Not reported". */
  byProvider: { provider: string; tokens: TokenTotals; notReported?: true }[]
  byModel: { provider: string; model: string; tokens: TokenTotals }[]
  planCheck: TokenTotals
}

/** One day of the chart; `byProvider` maps provider to total tokens, empty for a day with no usage. */
export interface DailyUsage {
  day: string
  byProvider: Record<string, number>
}

/** One Biggest spenders row. Provider and model read "Mixed" when more than one pair contributed. */
export interface SpenderRow {
  key: string
  name: string
  groupName: string | null
  provider: string
  model: string
  total: number
  sessionId?: string
  workerId?: string
  /** False when the session was deleted, so there is nothing to open. */
  clickable: boolean
  /** Commands only: distinct agent runs. */
  runs?: number
}

/**
 * What `usage:get-report` answers for the Usage page. `spenders` holds the top rows of each kind, so
 * switching the list needs no further call. `suggestions` are the undismissed ones of the range,
 * newest first.
 */
export interface UsageReport {
  range: UsageRange
  totals: RangeTotals
  /** One entry per local day of the range, zero-filled; for `all`, from the first day with usage. */
  daily: DailyUsage[]
  spenders: Record<SpenderKind, SpenderRow[]>
  plans: PlanSnapshot['plans']
  suggestions: Suggestion[]
  generatedAt: number
}

export type SuggestionKind =
  'model-too-strong' | 'setup-overhead' | 'repeated-work' | 'long-running'

/** One open saving suggestion, with the session it links to. */
export interface Suggestion {
  id: string
  kind: SuggestionKind
  sessionId: string
  sessionName: string
  agentKey?: string
  workerId?: string
  text: string
  advice: string
  /** The numbers and names the text was built from. */
  params: Record<string, unknown>
  createdAt: number
}
