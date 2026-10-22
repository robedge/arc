import { existsSync, mkdirSync } from 'node:fs'
import type { LoadRole } from '../../shared/types/agent-load'
import { join } from 'node:path'
import type {
  WorkerStatus,
  WorkerStoppedBy,
  WorkerView,
  WorkerWorktreeView
} from '@shared/types/session'
import { ProviderHistoryMissingError, ProviderUnavailableError } from '../agents/agent-adapter'
import type { CodexCommandRunner } from '../agents/codex/codex-commands'
import type { CursorCommandRunner } from '../agents/cursor/cursor-commands'
import type { CodexInput } from '../agents/codex/codex-types'
import type {
  AgentHandle,
  ClaudeStartOptions,
  CodexStartOptions,
  CommonStartOptions,
  CursorStartOptions,
  InterruptOutcome,
  StartOptions
} from '../agents/agent-adapter'
import type { ProviderRegistry } from '../agents/provider-registry'
import type { AgentEvent } from '../agents/agent-events'
import type { ClassifyContext } from '../policy/classify'
import { PERMISSION_PROMPT_TOOL } from '../agents/claude-adapter'
import { BridgeToolError } from '../bridge/types'
import {
  applyCodexMcp,
  applyCursorMcp,
  type PersonalLaunchConfig
} from '../personal/personal-config'
import { DEGRADED_MCP_NOTE } from '../personal/personal-notes'
import type {
  BridgeAgent,
  BridgeServices,
  ReportDoneInput,
  ReportProgressInput,
  SpawnWorkerInput,
  SpawnWorkerResult,
  WorkerStatusEntry
} from '../bridge/types'
import type { BridgeRegistry } from '../bridge/bridge-server'
import { toolsForRole } from '../bridge/tools/registry'
import { assertNever } from '@shared/assert-never'
import { planRefusedText, providerName, runningOnLabel } from '@shared/provider-label'
import { PROVIDER_IDS } from '@shared/types/provider'
import type { ModelRef, ProviderId, ProviderStatusMap } from '@shared/types/provider'
import { workerRunningOn } from './running-on'
import type { AttentionRequestRow } from '../db/repositories/attention-repo'
import type { CommitsRepo } from '../db/repositories/commits-repo'
import type {
  SessionProjectRow,
  SessionProjectsRepo
} from '../db/repositories/session-projects-repo'
import type { SessionsRepo } from '../db/repositories/sessions-repo'
import type { WorkerRow, WorkersRepo } from '../db/repositories/workers-repo'
import { rootOf } from '../usage/read-paths'
import { usageAgentKey } from '../usage/usage-recorder'
import type { UsageRecorder, UsageRun, UsageTracker } from '../usage/usage-recorder'
import { forwardRateLimit } from '../usage/plan-usage-service'
import type { PlanUsageService } from '../usage/plan-usage-service'
import type { TokenTotals } from '../../shared/types/usage'
import type { HeldMessagesRepo } from '../db/repositories/held-messages-repo'
import type { WorkerWorktreeRow, WorktreesRepo } from '../db/repositories/worktrees-repo'
import { AppErrorException } from '@shared/errors'
import { slugify } from '../git/session-git'
import type { WorktreeGit } from '../git/worktrees'
import { answerNote } from './attention-coordinator'
import type { RateLimitGate } from './rate-limit-gate'
import { classifyWorkerExit } from './worker-exit'
import { RESOLVER_MARKER, commandName, isResolverRow, workerLabel as labelOf } from './worker-label'
import type { ModelRegistry } from '../models/model-registry'
import { reasonOf, resolveWorkerTarget, standInFor } from '../models/provider-resolution'
import type { FallbackReason, WorkerTarget } from '../models/provider-resolution'
import {
  commandNeedsProviderText,
  fallbackReasonText,
  workerCannotContinueText,
  workerFallbackText
} from '../providers/fallback-text'
import { workersPrefOf } from './session-prefs'
import {
  CURSOR_REJECTED_LINE,
  CURSOR_TOOL_LINE,
  CURSOR_WAIT_FOR_LINE
} from '../agents/cursor/cursor-instructions'
import { createCodexApprovalHandler, McpCoverage } from './codex-approvals'
import { writeCursorDeny } from '../agents/cursor/cursor-deny'
import { classifyUnaskedCall, cursorBlockedText } from '../agents/cursor/cursor-unasked'
import type { CursorToolCall } from '../agents/cursor/cursor-types'
import { createCursorApprovalHandler } from './cursor-approvals'
import { TerminalLog } from './terminal-log'
import { BRAIN_MESSAGE_PREFIX, CODEX_SLASH_LINE, typedSlashName } from './typed-slash'
import { discardWorkingCopy } from './working-copy'
import type { TerminalBacklog, TerminalChunk } from './terminal-log'

export const RESOLVER_SLUG = 'merge-conflict'

/** The card line of a queued worker whose provider waits for its usage limit. */
function waitingActivity(provider: ProviderId): string {
  return `Waiting for ${providerName(provider)} limit`
}

/** A worker's blocking calls (permission, questions) wait as long as the user takes. */
export const WORKER_MCP_TOOL_TIMEOUT_MS = '43200000'

/** At most one `session:worker-changed` push per worker in this window. */
export const WORKER_PUSH_MS = 250
/** The activity line is written at most this often. */
const ACTIVITY_MS = 1000
const SUMMARY_MAX = 600
/** Safety cap: a worker is not kept waiting for background helpers longer than this. */
export const HELPER_CAP_MS = 10 * 60 * 1000
/** After the helpers end, a deferred turn waits this long for the CLI's follow-up turn. */
export const HELPER_SETTLE_MS = 60 * 1000
/** Helper tool calls remembered per worker, to label their permission cards. */
const HELPER_TOOL_IDS_MAX = 500

/** Statuses a worker can be stepped in on (tech spec 2.4); `queued` has no process to take over. */
const STEPPABLE: readonly WorkerStatus[] = ['starting', 'working', 'needs_approval', 'has_question']

/** The user turn that returns control to the worker (tech spec 2.4, hand back, step 4). */
export const HAND_BACK_TEXT =
  '[Arc] The user has handed control back to you. Continue your original task, taking into account everything the user said and changed while they were in control (their messages are in the conversation above). Check your working copy with git status before you carry on. Commit and call report_done when you are finished.'

/** What the brain is told when the user steps in. */
export const stepInNote = (label: string): string =>
  `[Arc] The user stepped in on ${label} and is talking to it directly. Do not message, merge or stop it. You will be told when they hand it back.`

/** Added to the hand-back text when the worker called report_done while the user was in control. */
export const HAND_BACK_REPORTED_DONE_TEXT =
  " Note: you already called report_done earlier in this task. If the user's changes need nothing more from you, reply briefly and stop; otherwise finish the work, commit and call report_done again."

/** One held brain message, as the worker receives it after the hand-back text. */
export const heldMessageText = (body: string): string =>
  `[Arc] Message from the brain (held while the user was in control): ${body}`

/** Longest diffstat the brain is shown; the rest is cut. */
const HAND_BACK_STAT_MAX = 600

export interface HandBackSummary {
  /** `git diff --stat` lines since step-in (plus untracked files), one per file; empty when nothing changed. */
  changes: readonly string[]
  /** Lines the user typed to the worker. */
  messages: number
  /** The last typed line, already cut to 200 characters. */
  lastMessage: string | null
  /** Brain messages that were held and are delivered now. */
  held: number
}

/** What the brain is told when the user hands a worker back (tech spec 2.4, hand back, step 7). */
export function handBackNote(label: string, summary: HandBackSummary): string {
  let stat = summary.changes.join('; ')
  if (stat.length > HAND_BACK_STAT_MAX) stat = `${stat.slice(0, HAND_BACK_STAT_MAX)}...`
  const changed = stat === '' ? 'no file changes' : stat
  const sent =
    summary.messages === 0
      ? 'They sent no messages.'
      : `They sent ${summary.messages} message${summary.messages === 1 ? '' : 's'}; last: "${summary.lastMessage ?? ''}".`
  const delivered =
    summary.held === 0
      ? ''
      : ` Your ${summary.held === 1 ? 'held message was' : 'held messages were'} delivered.`
  return `[Arc] The user handed ${label} back. Changed since they stepped in: ${changed}. ${sent} It is continuing its task.${delivered}`
}

export interface WorkerLog {
  info: (message: string, ...rest: unknown[]) => void
  warn: (message: string, ...rest: unknown[]) => void
  error: (message: string, ...rest: unknown[]) => void
}

export interface WorkerHost {
  emitWorker: (worker: WorkerView) => void
  logEvent: (kind: string, text: string, data?: unknown, workerId?: string | null) => void
  /** A user-turn message to the brain (not shown in the conversation). */
  notifyBrain: (text: string) => void
  /** A full model id that an agent reported at start (`init` or `thread/start`). */
  learnModel: (ref: ModelRef) => void
  onSignedOut: () => void
  /** A worker's status changed (the list status depends on it). */
  onChange: () => void
  /** A batched chunk of a worker's terminal transcript (`worker:terminal`). */
  emitTerminal?: (workerId: string, chunk: TerminalChunk) => void
  /**
   * A worker (not a resolver) is Done. Returns true when Arc merges it by itself and tells the brain
   * the outcome, false when the brain has to be told the worker finished.
   */
  onWorkerDone?: (workerId: string) => boolean
  /** The usage-limit wait shared with the brain: while a provider waits, no worker is started on it. */
  rateLimit: Pick<RateLimitGate, 'isProviderWaiting' | 'hit' | 'cancel' | 'isWaiting'> &
    Partial<Pick<RateLimitGate, 'limitedProviders'>>
  /** Answers the worker never received because its call died with the process (oldest first). */
  undeliveredAnswers: (workerId: string) => AttentionRequestRow[]
  /** These answers reached the worker as a user turn. */
  markDelivered: (ids: string[]) => void
  /** Step-in: the worker's pending requests move from Needs attention to its terminal. */
  routeAttentionToTerminal: (workerId: string) => void
  /** Hand-back: they return to Needs attention and take the normal path again. */
  routeAttentionBack: (workerId: string) => void
}

export interface WorkerManagerDeps {
  sessionId: string
  registry: ProviderRegistry
  sessionsRepo: SessionsRepo
  workersRepo: WorkersRepo
  worktreesRepo: WorktreesRepo
  heldMessagesRepo: HeldMessagesRepo
  commitsRepo: CommitsRepo
  sessionProjectsRepo: SessionProjectsRepo
  worktreeGit: WorktreeGit
  bridge?: BridgeRegistry | undefined
  /** The engine behind the tools; handed to the bridge for each worker. */
  services: BridgeServices
  /** The models each provider offers, for `resolveTarget`. */
  models: ModelRegistry
  /**
   * The provider statuses. Left out (tests), Codex counts as unavailable and every worker runs on
   * Claude; with it, a Codex worker is checked again just before it spawns.
   */
  providers?:
    | {
        get: () => ProviderStatusMap
        ensureFresh: (provider: ProviderId) => Promise<unknown>
        /** A Codex start was refused for want of a login: the status says so from now on. */
        markSignedOut?: (provider: ProviderId) => void
      }
    | undefined
  /**
   * The user's Codex skills and prompts. A Codex worker's command becomes a skill input or the
   * expanded prompt; a typed `/name` that names a skill becomes a skill input, any other typed
   * `/name` gets the explanatory terminal line. Left out, there are none.
   */
  codexCommands?: CodexCommandRunner | undefined
  /** The user's Cursor commands and skills: a Cursor worker's command becomes the expanded file text. */
  cursorCommands?: CursorCommandRunner | undefined
  /** How long a worker waits for its background helpers before Arc stops waiting. Default 10 minutes. */
  helperCapMs?: number | undefined
  /** How long a deferred turn waits for a follow-up turn once the helpers are over. Default 60 s. */
  helperSettleMs?: number | undefined
  /** `userData/worktrees`. */
  getWorktreesRoot: () => string
  getKnowledgeDir: () => string
  /** `userData/sessions/<sid>/workers`; without it the terminal transcripts stay in memory. */
  getTerminalDir?: (() => string) | undefined
  /** The sanitized plugin view for agents of these repositories; undefined when it could not be built. */
  getPluginViewDir?:
    ((repoPaths: readonly string[], role: LoadRole) => Promise<string | undefined>) | undefined
  /** The user's own and their plugins' MCP servers and hooks for agents (spec 007 section 2.6). */
  personal?: PersonalLaunchConfig | undefined
  groupName: () => string
  /** Records each worker's and resolver's token usage; left out (tests), nothing is recorded. */
  usage?: UsageRecorder | undefined
  /** Receives the plan windows of the workers' `rate-limit` events; left out (tests), nothing is kept. */
  planUsage?: Pick<PlanUsageService, 'ingest'> | undefined
  now: () => number
  newId: () => string
  log: WorkerLog
}

export interface ResolverRequest {
  project: SessionProjectRow
  /** The temporary merge working copy; the resolver runs there. */
  mergePath: string
  /** The commit the merge started from. */
  baseSha: string
  /** The first message of the resolver. */
  task: string
  /** "W2 docs-update". */
  sourceLabel: string
  files: readonly string[]
}

export interface ResolverRun {
  workerId: string
  number: number
  /** Resolves with the resolver's end state once its exit is stored. */
  finished: Promise<'done' | 'failed' | 'stopped'>
}

export interface LaunchRequest {
  input: SpawnWorkerInput
  planId: string | null
  /** The provider that runs the worker (`resolveWorkerTarget`); its adapter starts it. */
  provider: ProviderId
  model: string
  modelNote: string | null
  /** The resolver put Claude in place of Codex: stored on the worker and explained in the event log. */
  fallback?: { from: ModelRef; reason: FallbackReason } | undefined
  /** A command that exists only on Codex while Codex is not ready: the worker fails without a process. */
  blocked?: { from: ModelRef; reason: FallbackReason; command: string } | undefined
}

/** What a caller knows when it asks where a new worker runs. */
export interface TargetPicks {
  command?: { provider: ProviderId; name?: string } | undefined
  planChoice?: Partial<ModelRef> | null | undefined
  proposal?: Partial<ModelRef> | null | undefined
}

interface Running {
  workerId: string
  agentId: string
  number: number
  slug: string
  handle: AgentHandle | undefined
  stopRequestedBy: WorkerStoppedBy | null
  reportedDone: boolean
  sawResult: boolean
  /** The agent hit the usage limit and waits; a turn that ends meanwhile is not a failure. */
  rateLimited: boolean
  nudged: boolean
  /** The user is in control: no nudge, failure or stop from a finished turn. Set before the interrupt. */
  controlActive: boolean
  /** A turn is running while the user is in control (their line was sent and has not ended). */
  controlReplying: boolean
  /** Arc interrupted a turn itself: the `interrupted` result that follows is not a finished turn. */
  ignoreInterrupted: boolean
  failReason: string | null
  /** Background helpers running now, by task id (the CLI's `background_tasks_changed` is authoritative). */
  helpers: Set<string>
  /** Tool calls made by helpers; a permission request with one of these ids is the helper's. */
  helperToolIds: Set<string>
  /** The turn ended while helpers ran: decided once they are over (or the cap passes). */
  deferredTurn: { ok: boolean } | null
  helperCapTimer: NodeJS.Timeout | undefined
  /** Grace timer: helpers are over, the deferred turn waits for a follow-up turn to start. */
  helperSettleTimer: NodeJS.Timeout | undefined
  /** The cap passed: helpers are no longer waited for. */
  helperCapped: boolean
  /** The activity line without the helper count. */
  activityBase: string
  lastActivityAt: number
  files: string[]
  lastReport: string | null
  recordChain: Promise<void>
  /** A merge resolver: no commit bookkeeping, and the brain is not told when it ends. */
  resolver: boolean
  /** Resolves once the exit has been classified and stored. */
  finished: Promise<void>
  markFinished: () => void
}

/** "10 minutes" (or seconds, for the short caps tests use). */
export function capText(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`
  const seconds = Math.max(1, Math.round(ms / 1000))
  return `${seconds} second${seconds === 1 ? '' : 's'}`
}

function parseIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function workerView(
  row: WorkerRow,
  worktrees: readonly WorkerWorktreeRow[],
  projectName: (projectId: string | null) => string,
  recordedCommits = 0,
  helpersRunning = 0,
  controlReplying = false,
  tokens?: TokenTotals | null,
  tokensInFlight = false
): WorkerView {
  const hasWorkingCopy = worktrees.some((w) => w.removedAt === null)
  const trees: WorkerWorktreeView[] = worktrees.map((w) => ({
    projectId: w.projectId,
    projectName: projectName(w.projectId),
    path: w.path,
    baseSha: w.baseSha,
    headSha: w.headSha
  }))
  return {
    id: row.id,
    sessionId: row.sessionId,
    number: row.number,
    slug: row.slug,
    task: row.task,
    role: isResolverRow(row) ? 'resolver' : 'worker',
    projectIds: parseIds(row.projectIdsJson),
    model: row.model,
    runningOn: workerRunningOn(row),
    status: row.status,
    activity: row.activity,
    failureReason: row.failureReason,
    summary: row.summary,
    stoppedBy: row.stoppedBy,
    worktrees: trees,
    hasWorkingCopy,
    unmergedCommits: row.status === 'merged' || !hasWorkingCopy ? 0 : recordedCommits,
    helpersRunning,
    userControl: row.userControl,
    controlReplying,
    ...(row.command !== null ? { command: row.command } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(tokensInFlight ? { tokensInFlight } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/** All workers of a session as views (used by the snapshot). */
export function buildWorkerViews(
  sessionId: string,
  workersRepo: WorkersRepo,
  worktreesRepo: WorktreesRepo,
  sessionProjectsRepo: SessionProjectsRepo,
  commitsRepo: CommitsRepo,
  helpersRunning: (workerId: string) => number = () => 0,
  controlReplying: (workerId: string) => boolean = () => false,
  /** Per `usage_turns.agent_key`; left out, the views carry no `tokens`. */
  tokensOf?: (agentKey: string) => TokenTotals | null,
  /** Per `usage_turns.agent_key`: the agent is mid-turn and `tokensOf` includes unsaved usage. */
  inFlightOf?: (agentKey: string) => boolean
): WorkerView[] {
  const names = new Map<string, string>()
  for (const p of sessionProjectsRepo.listBySession(sessionId)) {
    if (p.projectId !== null) names.set(p.projectId, p.projectName)
  }
  const trees = worktreesRepo.listBySession(sessionId)
  return workersRepo.listBySession(sessionId).map((row) =>
    workerView(
      row,
      trees.filter((t) => t.workerId === row.id),
      (id) => (id === null ? 'removed project' : (names.get(id) ?? 'removed project')),
      commitsRepo.listByWorker(row.id).length,
      helpersRunning(row.id),
      controlReplying(row.id),
      tokensOf?.(usageAgentKey(row)),
      inFlightOf?.(usageAgentKey(row)) ?? false
    )
  )
}

/** " (2 unmerged commits discarded)" or nothing. */
/** `shutdown()` writes Stopped first; waiting workers keep their status so a request can still be answered. */
function alreadyStoredForQuit(row: WorkerRow | undefined): boolean {
  return (
    row?.status === 'stopped' || row?.status === 'needs_approval' || row?.status === 'has_question'
  )
}

function discardNote(unmerged: number): string {
  return unmerged > 0 ? ` (${unmerged} unmerged commit${unmerged === 1 ? '' : 's'} discarded)` : ''
}

export const safeDirName = (name: string): string =>
  name.replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo'

export interface WorkerPromptInput {
  groupName: string
  number: number
  slug: string
  task: string
  /** The slash command the worker's first message runs; the task is then only a description. */
  command?: string | null | undefined
  branchName: string
  worktrees: readonly { projectName: string; path: string }[]
  /** The provider that runs the worker; Cursor is told how its tools are reached and about `wait_for`. */
  provider?: ProviderId | undefined
}

const TOOLSEARCH_LINE =
  '- Arc loads its tools with ToolSearch: search for "select:mcp__arc__report_progress,mcp__arc__report_done,mcp__arc__ask_brain" before your first call.'

/** How the agent is told to reach Arc's tools: Claude and Codex through ToolSearch, Cursor directly (plus `wait_for`). */
function toolRules(provider: ProviderId | undefined): string[] {
  return provider === 'cursor'
    ? [CURSOR_TOOL_LINE, CURSOR_WAIT_FOR_LINE, CURSOR_REJECTED_LINE]
    : [TOOLSEARCH_LINE]
}

/** The worker's system prompt. `[arc-role:worker]` and `[arc-worker:<slug>]` are read by the fake CLI. */
export function buildWorkerPrompt(input: WorkerPromptInput): string {
  const copies = input.worktrees.map((w) => `- ${w.projectName}: ${w.path}`).join('\n')
  return [
    '[arc-role:worker]',
    `[arc-worker:${input.slug}]`,
    `You are worker W${input.number} ("${input.slug}") in an Arc session for the group "${input.groupName}". The brain gave you one task; do it in your own working copies, then report.`,
    ...(input.command
      ? [
          '',
          `Your task: ${input.task}`,
          `Your first message is the command ${input.command}. Run it as a user would: follow it, in your working copies, and finish with the rest of these rules (commit, then report_done).`
        ]
      : []),
    '',
    `Your working copies (git worktrees detached at the session branch ${input.branchName}):`,
    copies,
    '',
    'Rules:',
    '- Work only inside your working copies. Other directories you can see are read only.',
    ...toolRules(input.provider),
    '- Call report_progress when you start and after each meaningful step, with one short sentence.',
    '- Commit your work in the working copy with git add and git commit. HEAD is detached; commit on it as it is. Never push, never switch branches.',
    '- Write plain commit messages: no Co-Authored-By trailer and no mention of the tool that wrote them.',
    '- Arc may pause a command or an edit outside your working copy while the brain or the user decides. If a request is denied, carry on without it; never try to work around a denial.',
    '- If you are blocked on a decision you cannot make from your task, call ask_brain with one clear question and wait for the answer.',
    '- When the task is finished and committed, call report_done with a short summary. Then stop.'
  ].join('\n')
}

export interface ResolverPromptInput {
  groupName: string
  number: number
  label: string
  projectName: string
  branchName: string
  mergePath: string
  files: readonly string[]
  provider?: ProviderId | undefined
}

/** The system prompt of a merge resolver. `[arc-worker:merge-conflict]` is read by the fake CLI. */
export function buildResolverPrompt(input: ResolverPromptInput): string {
  return [
    '[arc-role:worker]',
    `[arc-worker:${RESOLVER_SLUG}]`,
    `You are W${input.number}, a merge resolver in an Arc session for the group "${input.groupName}". Arc is merging the work of ${input.label} into the session branch ${input.branchName} of "${input.projectName}", and git stopped on conflicts.`,
    '',
    `You are in the merge working copy: ${input.mergePath}. The merge is in progress there.`,
    `Conflicted files: ${input.files.join(', ')}`,
    '',
    'Rules:',
    '- Resolve every conflicted file so that BOTH sides keep their intent: do not simply pick one side, and remove all conflict markers.',
    '- Then run git add on the resolved files and git commit --no-edit to finish the merge. Never push, never switch branches, change nothing else.',
    ...toolRules(input.provider),
    '- If you are not confident how to combine the two changes, call ask_brain with ONE clear question that names the file and says in one sentence what each side changed, then wait for the answer.',
    '- When the merge is committed, call report_done with a short summary of how you combined the changes. Then stop.'
  ].join('\n')
}

/** Starts, watches and finishes the workers of one session (tech spec 2.3, 2.5 and 2.7). */
export class WorkerManager {
  private readonly running = new Map<string, Running>()
  /** The working copies of each Cursor worker started, to refresh their deny files when another worker's copy appears. */
  private readonly cursorTrees = new Map<string, string[]>()
  /** The user MCP servers switched off for each Cursor worker; its deny file lists them. */
  private readonly cursorOffMcp = new Map<string, string[]>()
  private readonly pushState = new Map<
    string,
    { last: number; timer: NodeJS.Timeout | undefined }
  >()
  private readonly logs = new Map<string, TerminalLog>()
  private disposed = false
  private degradedMcpNoted = false
  /** Set while Arc quits: workers that exit then must not start queued ones. */
  private stopping = false

  constructor(
    private readonly deps: WorkerManagerDeps,
    private readonly host: WorkerHost
  ) {}

  // ---- queries ----

  views(): WorkerView[] {
    return buildWorkerViews(
      this.deps.sessionId,
      this.deps.workersRepo,
      this.deps.worktreesRepo,
      this.deps.sessionProjectsRepo,
      this.deps.commitsRepo,
      (id) => this.running.get(id)?.helpers.size ?? 0,
      (id) => this.running.get(id)?.controlReplying ?? false,
      this.deps.usage?.tokensOf(this.deps.sessionId),
      this.deps.usage?.inFlightOf(this.deps.sessionId)
    )
  }

  /** True when the tool call came from one of the worker's background helpers. */
  isHelperToolUse(workerId: string, toolUseId: string): boolean {
    return this.running.get(workerId)?.helperToolIds.has(toolUseId) ?? false
  }

  /** Workers of a plan entry that still count against it (a failed or stopped one can be started again). */
  hasLiveWorkerFor(planId: string, name: string): boolean {
    const slug = slugify(name)
    return this.deps.workersRepo
      .listBySession(this.deps.sessionId)
      .some(
        (w) =>
          w.planId === planId && w.slug === slug && w.status !== 'failed' && w.status !== 'stopped'
      )
  }

  isRunning(workerId: string): boolean {
    return this.running.has(workerId)
  }

  resolveRef(ref: string): WorkerRow | undefined {
    const rows = this.deps.workersRepo.listBySession(this.deps.sessionId)
    const byId = rows.find((w) => w.id === ref)
    if (byId) return byId
    const match = /^W?(\d+)$/i.exec(ref.trim())
    return match ? rows.find((w) => w.number === Number(match[1])) : undefined
  }

  status(ref: string | undefined): WorkerStatusEntry[] {
    const rows = this.deps.workersRepo.listBySession(this.deps.sessionId)
    const picked = ref === undefined ? rows : rows.filter((w) => w.id === this.resolveRef(ref)?.id)
    if (ref !== undefined && picked.length === 0) {
      throw new BridgeToolError('unknown_worker', `No worker "${ref}" in this session.`)
    }
    return picked.map((w) => {
      const run = this.running.get(w.id)
      return {
        id: w.id,
        number: w.number,
        name: w.slug,
        status: w.status,
        note: w.activity,
        files: run?.files ?? [],
        lastReport: run?.lastReport ?? w.summary
      }
    })
  }

  // ---- provider and model ----

  /**
   * Where a new worker runs: `resolveWorkerTarget` over the session's Workers choice and the given
   * picks. When any choice names Codex, Codex is checked again first if its status is not fresh
   * and ok, and its model list is loaded if still missing, so a Codex that was signed out at launch
   * and signed in since is used.
   */
  async resolveTarget(picks: TargetPicks): Promise<WorkerTarget> {
    const row = this.deps.sessionsRepo.getById(this.deps.sessionId)
    const sessionPref = row ? workersPrefOf(row) : ({ mode: 'auto' } as const)
    const named = new Set<ProviderId>()
    for (const provider of [
      picks.command?.provider,
      picks.planChoice?.provider,
      picks.proposal?.provider,
      sessionPref.mode === 'provider' ? sessionPref.provider : undefined,
      sessionPref.mode === 'model' ? sessionPref.model.provider : undefined
    ]) {
      if (provider !== undefined && provider !== 'claude') named.add(provider)
    }
    if (named.size > 0 && this.deps.providers) {
      for (const provider of named) {
        try {
          await this.deps.providers.ensureFresh(provider)
        } catch (error: unknown) {
          this.deps.log.warn(
            `could not check ${providerName(provider)} before starting a worker`,
            error
          )
        }
      }
      await this.deps.models.refresh()
    }
    return resolveWorkerTarget({
      ...picks,
      sessionPref,
      registry: this.deps.models,
      status: this.deps.providers?.get() ?? {},
      limited: this.host.rateLimit.limitedProviders?.()
    })
  }

  // ---- spawn ----

  /**
   * Stores a new worker. At or over the session's worker limit it waits as `queued` (no working copy
   * yet: it is created when the worker really starts, from the then-current session tip); otherwise
   * it starts now. The count and the insert happen in one tick, so concurrent spawns cannot overshoot.
   */
  async spawn(request: LaunchRequest): Promise<SpawnWorkerResult> {
    const { input } = request
    const projects = this.resolveRepos(input.repos)
    const limit = this.workerLimit()
    const overLimit = this.deps.workersRepo.countActive(this.deps.sessionId) >= limit
    // A worker whose provider waits for its limit runs on the stand-in when there is one (it has no
    // conversation yet); only without one does it wait for the provider.
    const standIn = this.host.rateLimit.isProviderWaiting(request.provider)
      ? this.waitStandIn(request.provider, request.model, input.command)
      : null
    const provider = standIn?.provider ?? request.provider
    const model = standIn?.model ?? request.model
    const fallback =
      standIn === null
        ? request.fallback
        : {
            from: request.fallback?.from ?? { provider: request.provider, model: request.model },
            reason: 'limit' as const
          }
    const heldBy = this.host.rateLimit.isProviderWaiting(provider) ? provider : null
    const queued = overLimit || heldBy !== null
    const workerId = this.deps.newId()
    const now = this.deps.now()
    const number = this.deps.workersRepo.nextNumber(this.deps.sessionId)
    const slug = slugify(input.name)
    const echo = { provider, model, note: request.modelNote }
    if (request.blocked) this.failBlockedCommand(request, request.blocked, projects, number, slug)
    const row = this.deps.workersRepo.insert({
      id: workerId,
      sessionId: this.deps.sessionId,
      number,
      slug,
      task: input.task,
      command: input.command ?? null,
      projectIdsJson: JSON.stringify(projects.map((p) => p.projectId)),
      provider,
      model,
      ...this.fallbackColumns(fallback),
      status: queued ? 'queued' : 'starting',
      activity: !queued ? 'Starting' : heldBy !== null ? waitingActivity(heldBy) : 'Queued',
      failureReason: null,
      summary: null,
      providerSessionId: null,
      planId: request.planId,
      dependsOnJson: JSON.stringify(input.dependsOn ?? []),
      stoppedBy: null,
      createdAt: now,
      updatedAt: now
    })
    if (fallback) {
      this.host.logEvent(
        'provider-fallback',
        workerFallbackText(
          fallbackLabel(row),
          fallback.reason,
          fallback.from.provider,
          row.provider
        ),
        { reason: fallback.reason },
        workerId
      )
    } else if (request.modelNote) {
      this.host.logEvent('model', request.modelNote, undefined, workerId)
    }
    this.pushNow(workerId)
    this.host.onChange()
    if (queued) {
      this.host.logEvent(
        'worker-queued',
        heldBy === null
          ? `${labelOf(row)} queued (limit ${limit})`
          : `${labelOf(row)} queued: waiting for the ${providerName(heldBy)} usage limit`,
        heldBy === null ? { limit } : { waitingFor: heldBy },
        workerId
      )
      return { workerId, status: 'queued', ...echo }
    }
    await this.startRow(row, projects)
    return { workerId, status: 'started', ...echo }
  }

  // ---- Codex or Cursor is not available ----

  /** The stored columns of a worker that runs on another provider than the one asked for; empty without a fallback. */
  private fallbackColumns(
    fallback: { from: ModelRef; reason: FallbackReason } | undefined
  ): { requestedProvider: ProviderId; fallbackReason: string } | Record<string, never> {
    return fallback === undefined
      ? {}
      : {
          requestedProvider: fallback.from.provider,
          fallbackReason: fallbackReasonText(fallback.reason, fallback.from.provider)
        }
  }

  /**
   * A command that exists only on Codex or Cursor cannot fall back. The worker is stored as failed
   * with the reason, no working copy is made and no process starts; the brain gets the same sentence.
   */
  private failBlockedCommand(
    request: LaunchRequest,
    blocked: NonNullable<LaunchRequest['blocked']>,
    projects: readonly { projectId: string | null }[],
    number: number,
    slug: string
  ): never {
    const { input } = request
    const now = this.deps.now()
    const command = commandName(input.command)
    const reason = commandNeedsProviderText(
      `W${number}`,
      command === null ? (input.command ?? 'a command') : `/${command}`,
      blocked.reason,
      blocked.from.provider
    )
    const row = this.deps.workersRepo.insert({
      id: this.deps.newId(),
      sessionId: this.deps.sessionId,
      number,
      slug,
      task: input.task,
      command: input.command ?? null,
      projectIdsJson: JSON.stringify(projects.map((p) => p.projectId)),
      provider: request.provider,
      model: request.model,
      status: 'failed',
      activity: null,
      failureReason: reason,
      summary: null,
      providerSessionId: null,
      planId: request.planId,
      dependsOnJson: JSON.stringify(input.dependsOn ?? []),
      stoppedBy: null,
      createdAt: now,
      updatedAt: now
    })
    this.host.logEvent(
      'worker-failed',
      `${labelOf(row)} failed: ${reason}`,
      { reason: blocked.reason },
      row.id
    )
    this.pushNow(row.id)
    this.host.onChange()
    throw new BridgeToolError(`${blocked.from.provider}_unavailable`, reason)
  }

  /**
   * Why a Codex or Cursor worker cannot start right now, or null when it can: the provider is
   * checked again first (cheap while the last check is fresh and ok). A fresh start also counts a
   * provider at its usage limit as unavailable; a worker that already has a conversation does not
   * (`ignoreLimit`), it just waits for the limit again. Without a status service nothing is known and
   * the start goes ahead.
   */
  private async providerBlockReason(
    provider: ProviderId,
    ignoreLimit = false
  ): Promise<FallbackReason | null> {
    const providers = this.deps.providers
    if (!providers) return null
    try {
      await providers.ensureFresh(provider)
    } catch (error: unknown) {
      this.deps.log.warn(
        `could not check ${providerName(provider)} before starting a worker`,
        error
      )
    }
    const state = providers.get()[provider]?.state
    if (state !== 'ok') return reasonOf(state)
    return !ignoreLimit && this.host.rateLimit.limitedProviders?.().has(provider) === true
      ? 'limit'
      : null
  }

  /** The login is gone although the status said ok: record it, so the next start does not try the provider. */
  private noteProviderDown(provider: ProviderId, reason: FallbackReason): void {
    if (reason === 'signed_out') this.deps.providers?.markSignedOut?.(provider)
  }

  /**
   * Moves a Codex or Cursor worker that has not run yet to the first ready provider of the chain
   * (Claude, then Codex) at the same tier, and says so. Only for a first start: a worker with a
   * conversation on its provider is never moved (`keepStopped`).
   */
  private fallBack(row: WorkerRow, reason: FallbackReason, target?: ModelRef): WorkerRow {
    const now = this.deps.now()
    const from = row.provider
    const to =
      target ??
      standInFor(
        from,
        this.deps.models.tierOf({ provider: from, model: row.model }),
        this.deps.models,
        this.deps.providers?.get() ?? {},
        this.host.rateLimit.limitedProviders?.()
      )
    this.deps.workersRepo.setTarget(row.id, to.provider, to.model, now)
    this.deps.workersRepo.setFallback(row.id, from, fallbackReasonText(reason, from), now)
    this.host.logEvent(
      'provider-fallback',
      workerFallbackText(fallbackLabel(row), reason, from, to.provider),
      { reason },
      row.id
    )
    this.pushNow(row.id)
    this.host.onChange()
    return this.deps.workersRepo.get(row.id) ?? row
  }

  /**
   * Where a Codex or Cursor worker that has not run yet goes while its provider waits for the usage
   * limit: the first ready provider of the chain that is not waiting itself, or null when there is
   * none and the worker holds. A worker that runs a provider's own command does not move, as when
   * the provider is unavailable.
   */
  private waitStandIn(
    provider: ProviderId,
    model: string,
    command: string | null | undefined
  ): ModelRef | null {
    if (provider === 'claude' || command) return null
    const waiting = new Set(this.host.rateLimit.limitedProviders?.() ?? [])
    for (const id of PROVIDER_IDS) {
      if (this.host.rateLimit.isProviderWaiting(id)) waiting.add(id)
    }
    const to = standInFor(
      provider,
      this.deps.models.tierOf({ provider, model }),
      this.deps.models,
      this.deps.providers?.get() ?? {},
      waiting
    )
    return to.provider === provider || waiting.has(to.provider) ? null : to
  }

  /** A fresh Codex or Cursor start whose status is not ok runs on the stand-in from the start. */
  private async checkedBeforeStart(row: WorkerRow): Promise<WorkerRow> {
    if (row.provider === 'claude') return row
    const reason = await this.providerBlockReason(row.provider)
    return reason === null ? row : this.fallBack(row, reason)
  }

  /**
   * `launch` for a first start. When the provider refuses it at the handshake (the status said ok,
   * the account check failed) the worker starts again on the stand-in with the same task, and the
   * fallback is stored and logged like one decided earlier.
   */
  private async launchOrFallBack(
    run: Running,
    row: WorkerRow,
    trees: readonly { project: SessionProjectRow; path: string }[],
    sessionSlug: string | null,
    projects: readonly SessionProjectRow[],
    prompt?: string
  ): Promise<void> {
    try {
      await this.launch(run, row, trees, sessionSlug, projects, prompt)
    } catch (error: unknown) {
      if (!(error instanceof ProviderUnavailableError) || row.provider === 'claude') throw error
      this.deps.bridge?.revokeAgent(run.agentId)
      this.noteProviderDown(row.provider, error.reason)
      const moved = this.fallBack(row, error.reason)
      await this.launch(run, moved, trees, sessionSlug, projects, prompt)
    }
  }

  /**
   * A stopped or paused Codex or Cursor worker cannot continue without its provider, and its history
   * cannot move to another: it stays stopped (Continue works once the provider is back) and the log
   * says what to do.
   */
  private keepStopped(row: WorkerRow, reason: FallbackReason): void {
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(
      row.id,
      'stopped',
      now,
      row.status === 'stopped' ? row.stoppedBy : 'quit'
    )
    this.deps.workersRepo.setActivity(row.id, null, now)
    this.host.logEvent(
      'provider-unavailable',
      workerCannotContinueText(fallbackLabel(row), reason, row.provider),
      { reason },
      row.id
    )
    this.pushNow(row.id)
    this.host.onChange()
  }

  // ---- merging (tech spec 2.7) ----

  /**
   * Starts the short-lived resolver of a conflicting merge in the merge working copy. It is a worker
   * row with the worktree row of the merge copy (so its edits count as inside its working copy), and
   * it ignores the worker limit: the merge it serves is waiting on it.
   */
  async startResolver(request: ResolverRequest): Promise<ResolverRun> {
    const session = this.deps.sessionsRepo.getById(this.deps.sessionId)
    const workerId = this.deps.newId()
    const now = this.deps.now()
    const number = this.deps.workersRepo.nextNumber(this.deps.sessionId)
    const target = await this.resolveTarget({})
    const { provider, model } = target.ref
    const project = request.project
    const row = this.deps.workersRepo.insert({
      id: workerId,
      sessionId: this.deps.sessionId,
      number,
      slug: RESOLVER_SLUG,
      task: request.task,
      projectIdsJson: JSON.stringify(project.projectId === null ? [] : [project.projectId]),
      provider,
      model,
      ...this.fallbackColumns(target.fallback),
      status: 'starting',
      activity: 'Starting',
      failureReason: null,
      summary: null,
      providerSessionId: null,
      planId: null,
      dependsOnJson: JSON.stringify([RESOLVER_MARKER]),
      stoppedBy: null,
      createdAt: now,
      updatedAt: now
    })
    this.deps.worktreesRepo.insert({
      workerId,
      projectId: project.projectId,
      path: request.mergePath,
      baseSha: request.baseSha,
      headSha: request.baseSha,
      removedAt: null
    })
    const label = 'Conflict resolver'
    if (target.fallback) {
      this.host.logEvent(
        'provider-fallback',
        workerFallbackText(
          fallbackLabel(row),
          target.fallback.reason,
          target.fallback.from.provider,
          row.provider
        ),
        { reason: target.fallback.reason },
        workerId
      )
    }
    this.host.logEvent(
      'worker-started',
      `started ${label} · ${runningOnLabel(workerRunningOn(row))}`,
      { model },
      workerId
    )
    this.pushNow(workerId)
    this.host.onChange()
    const run = this.makeRunning(row)
    run.resolver = true
    if (this.stopping) run.stopRequestedBy = 'quit'
    this.running.set(workerId, run)
    try {
      await this.launchOrFallBack(
        run,
        row,
        [{ project, path: request.mergePath }],
        session?.slug ?? null,
        [project],
        buildResolverPrompt({
          groupName: this.deps.groupName(),
          number,
          label: request.sourceLabel,
          projectName: project.projectName,
          branchName: project.branchName ?? `arc/${session?.slug ?? 'session'}`,
          mergePath: request.mergePath,
          files: request.files,
          provider: row.provider
        })
      )
    } catch (error: unknown) {
      this.running.delete(workerId)
      this.deps.bridge?.revokeAgent(run.agentId)
      const reason = `The resolver could not be started: ${error instanceof Error ? error.message : String(error)}`
      this.deps.log.error(`worker ${label}: ${reason}`)
      this.deps.workersRepo.setFailure(workerId, reason, this.deps.now())
      this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, workerId)
      this.pushNow(workerId)
      this.host.onChange()
      run.markFinished()
      throw new BridgeToolError('start_failed', reason)
    }
    return {
      workerId,
      number,
      finished: run.finished.then(() => {
        const status = this.deps.workersRepo.get(workerId)?.status
        return status === 'done' ? 'done' : status === 'stopped' ? 'stopped' : 'failed'
      })
    }
  }

  /** Stops a resolver whose merge no longer needs it (the user answered "no", or the merge was dropped). */
  async stopResolver(workerId: string): Promise<void> {
    if (this.running.has(workerId)) await this.stop(workerId, 'user')
  }

  /** Reads and stores the HEAD sha and commits of a worker's working copies (a worker that is not running). */
  async syncHeads(workerId: string): Promise<void> {
    await this.doRecordHeads(workerId)
  }

  /** The worker's work is in the session branch. */
  markMerged(workerId: string): void {
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(workerId, 'merged', now)
    this.deps.workersRepo.setActivity(workerId, null, now)
    this.pushNow(workerId)
    this.host.onChange()
  }

  /** Pushes a worker's current state (its working copy was removed, for instance). */
  pushWorker(workerId: string): void {
    this.pushNow(workerId)
  }

  private workerLimit(): number {
    return this.deps.sessionsRepo.getById(this.deps.sessionId)?.workerLimit ?? 1
  }

  /**
   * Starts queued workers, oldest first, while the running count is under the limit. Called whenever
   * a worker leaves a running status, when the limit changes and when a usage-limit wait ends. A
   * worker whose provider waits for its limit moves to a stand-in when it has not run yet and one is
   * ready, else stays queued; the ones behind it still start. Every queued card says why it waits.
   * Lowering the limit never stops a running worker; it only delays the queue.
   */
  drain(): void {
    if (this.disposed || this.stopping) return
    const limit = this.workerLimit()
    let active = this.deps.workersRepo.countActive(this.deps.sessionId)
    for (let row of this.deps.workersRepo.listBySession(this.deps.sessionId)) {
      if (row.status !== 'queued') continue
      if (this.host.rateLimit.isProviderWaiting(row.provider)) {
        // Never started, so it can run elsewhere; otherwise it holds for its provider.
        const to = this.waitStandIn(row.provider, row.model, row.command)
        if (to !== null && row.providerSessionId === null && !isResolverRow(row)) {
          row = this.fallBack(row, 'limit', to)
        }
      }
      // The card says why it waits: its provider's limit first, else the worker limit.
      const activity = this.host.rateLimit.isProviderWaiting(row.provider)
        ? waitingActivity(row.provider)
        : 'Queued'
      if (row.activity !== activity) {
        this.deps.workersRepo.setActivity(row.id, activity, this.deps.now())
        this.pushNow(row.id)
      }
      if (this.host.rateLimit.isProviderWaiting(row.provider) || active >= limit) continue
      active += 1
      this.deps.workersRepo.setStatus(row.id, 'starting', this.deps.now())
      this.deps.workersRepo.setActivity(row.id, 'Starting', this.deps.now())
      this.pushNow(row.id)
      void this.startQueued(row)
    }
  }

  private async startQueued(row: WorkerRow): Promise<void> {
    const label = labelOf(row)
    try {
      const wanted = new Set(parseIds(row.projectIdsJson))
      const projects = this.deps.sessionProjectsRepo
        .listBySession(this.deps.sessionId)
        .filter((p) => p.projectId !== null && wanted.has(p.projectId))
      if (projects.length !== wanted.size || projects.some((p) => p.branchName === null)) {
        throw new BridgeToolError(
          'unknown_repo',
          'A project of this worker is no longer available.'
        )
      }
      await this.startRow(this.deps.workersRepo.get(row.id) ?? row, projects)
    } catch (error: unknown) {
      if (this.disposed) return
      const reason = error instanceof BridgeToolError ? error.message : String(error)
      const current = this.deps.workersRepo.get(row.id)
      if (current && current.status !== 'failed') {
        this.deps.workersRepo.setFailure(row.id, reason, this.deps.now())
        this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, row.id)
        this.pushNow(row.id)
        this.host.onChange()
      }
      this.host.notifyBrain(
        `[Arc] Worker W${row.number} failed: ${reason.replace(/\.$/, '')}. Decide how to continue and tell the user.`
      )
      this.drain()
    }
  }

  /** Creates the working copies and launches the worker for a row that is already `starting`. */
  private async startRow(row: WorkerRow, projects: readonly SessionProjectRow[]): Promise<void> {
    const workerId = row.id
    const sessionRow = this.deps.sessionsRepo.getById(this.deps.sessionId)
    const label = labelOf(row)
    let trees: { project: SessionProjectRow; path: string }[]
    try {
      trees = await this.createWorktrees(workerId, projects)
    } catch (error: unknown) {
      const reason = `Could not create the working copy: ${error instanceof Error ? error.message : String(error)}`
      this.deps.log.error(`worker ${label}: ${reason}`)
      this.deps.workersRepo.setFailure(workerId, reason, this.deps.now())
      this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, workerId)
      this.pushNow(workerId)
      this.host.onChange()
      this.drain()
      throw new BridgeToolError('worktree_failed', reason)
    }

    // A queued Codex worker may start after Codex went away: check again, and run on Claude if so.
    const current = await this.checkedBeforeStart(row)
    this.host.logEvent(
      'worker-started',
      `started ${label} · ${runningOnLabel(workerRunningOn(current))}`,
      { model: current.model },
      workerId
    )
    const run: Running = this.makeRunning(current)
    // Arc is quitting: stopAll has already looked at the running set, so this one stops itself.
    if (this.stopping) run.stopRequestedBy = 'quit'
    this.running.set(workerId, run)
    try {
      await this.launchOrFallBack(run, current, trees, sessionRow?.slug ?? null, projects)
    } catch (error: unknown) {
      this.running.delete(workerId)
      this.deps.bridge?.revokeAgent(run.agentId)
      const reason = `The worker could not be started: ${error instanceof Error ? error.message : String(error)}`
      this.logFor(workerId).finish(`Failed: ${reason}`)
      this.deps.log.error(`worker ${label}: ${reason}`)
      this.deps.workersRepo.setFailure(workerId, reason, this.deps.now())
      this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, workerId)
      this.pushNow(workerId)
      this.host.onChange()
      run.markFinished()
      this.drain()
      throw new BridgeToolError('start_failed', reason)
    }
  }

  private makeRunning(row: WorkerRow): Running {
    let markFinished: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      markFinished = resolve
    })
    return {
      workerId: row.id,
      agentId: `worker-${row.id}`,
      number: row.number,
      slug: row.slug,
      handle: undefined,
      stopRequestedBy: null,
      reportedDone: false,
      sawResult: false,
      rateLimited: false,
      nudged: false,
      controlActive: false,
      controlReplying: false,
      ignoreInterrupted: false,
      failReason: null,
      helpers: new Set(),
      helperToolIds: new Set(),
      deferredTurn: null,
      helperCapTimer: undefined,
      helperSettleTimer: undefined,
      helperCapped: false,
      activityBase: 'Working',
      lastActivityAt: 0,
      files: [],
      lastReport: null,
      recordChain: Promise.resolve(),
      resolver: false,
      finished,
      markFinished
    }
  }

  /** Session projects by name; the error names the problem so the brain can fix its call. */
  resolveRepos(names: readonly string[], requireBranch = true): SessionProjectRow[] {
    const all = this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)
    const picked: SessionProjectRow[] = []
    for (const name of names) {
      const wanted = name.trim().toLowerCase()
      const active = all.filter((p) => p.membership === 'active')
      const project =
        active.find((p) => p.projectName === name.trim()) ??
        active.find((p) => p.projectName.toLowerCase() === wanted)
      if (!project) {
        const gone = all.find((p) => p.projectName.toLowerCase() === wanted)
        if (gone?.membership === 'removed') {
          throw new BridgeToolError(
            'unknown_repo',
            `"${gone.projectName}" is no longer part of the group; workers cannot start there.`
          )
        }
        if (gone?.membership === 'left_out') {
          throw new BridgeToolError(
            'unknown_repo',
            `"${gone.projectName}" is not part of this session (the user kept it out), so workers cannot start there.`
          )
        }
      }
      if (!project || project.projectId === null) {
        throw new BridgeToolError('unknown_repo', `"${name}" is not a project of this session.`)
      }
      if (project.readOnly) {
        throw new BridgeToolError(
          'unknown_repo',
          `"${project.projectName}" is read only (not a git repository); workers cannot change it.`
        )
      }
      if (requireBranch && project.branchName === null) {
        throw new BridgeToolError(
          'branch_not_ready',
          `The session branch for "${project.projectName}" is not created yet. Try again in a moment.`
        )
      }
      if (!picked.includes(project)) picked.push(project)
    }
    return picked
  }

  private async createWorktrees(
    workerId: string,
    projects: readonly SessionProjectRow[]
  ): Promise<{ project: SessionProjectRow; path: string }[]> {
    const created: { project: SessionProjectRow; path: string }[] = []
    const used = new Set<string>()
    try {
      for (const project of projects) {
        let dir = safeDirName(project.projectName)
        for (let n = 2; used.has(dir); n++) dir = `${safeDirName(project.projectName)}-${n}`
        used.add(dir)
        const path = join(this.deps.getWorktreesRoot(), this.deps.sessionId, workerId, dir)
        mkdirSync(join(this.deps.getWorktreesRoot(), this.deps.sessionId, workerId), {
          recursive: true
        })
        const { baseSha } = await this.deps.worktreeGit.addDetached(
          project.projectPath,
          path,
          project.branchName as string
        )
        this.deps.worktreesRepo.insert({
          workerId,
          projectId: project.projectId,
          path,
          baseSha,
          headSha: baseSha,
          removedAt: null
        })
        created.push({ project, path })
      }
    } catch (error: unknown) {
      for (const tree of created) {
        await this.deps.worktreeGit
          .remove(tree.project.projectPath, tree.path)
          .catch(() => undefined)
      }
      throw error
    }
    return created
  }

  /** Only awaited when the dependency exists, so launches without it keep their timing. */
  private async pluginViewDir(repoPaths: readonly string[]): Promise<string | undefined> {
    try {
      return await this.deps.getPluginViewDir?.(repoPaths, 'workers')
    } catch (error: unknown) {
      this.deps.log.warn('plugin view unavailable; starting the agent without it', error)
      return undefined
    }
  }

  /**
   * The merged `--mcp-config` and the hooks-only `--settings` file replace the bridge's own config,
   * so the worker loads the user's MCP servers and hooks too. When they cannot be written the worker
   * starts with the bridge config alone.
   */
  private async applyPersonalClaude(
    claude: ClaudeStartOptions,
    repoPaths: readonly string[],
    arcConfigPath: string
  ): Promise<void> {
    if (!this.deps.personal) return
    try {
      const files = await this.deps.personal.claude({
        repoPaths,
        arcConfigPath,
        role: 'workers'
      })
      claude.mcpConfigPath = files.mcpConfigPath
      if (files.hooksSettingsPath) claude.hooksSettingsPath = files.hooksSettingsPath
    } catch (error: unknown) {
      this.deps.log.warn(
        'personal MCP servers and hooks unavailable; starting the agent without them',
        error
      )
    }
  }

  private async launch(
    run: Running,
    row: WorkerRow,
    trees: readonly { project: SessionProjectRow; path: string }[],
    sessionSlug: string | null,
    projects: readonly SessionProjectRow[],
    prompt?: string,
    resume?: { sessionId: string | null; message: string; freshMessage: string }
  ): Promise<void> {
    const first = trees[0]
    if (!first) throw new Error('no working copy')
    this.logFor(run.workerId).status('Starting')
    const knowledgeDir = this.deps.getKnowledgeDir()
    const otherCheckouts = this.otherCheckouts(new Set(projects.map((p) => p.projectPath)))
    const claude: ClaudeStartOptions = { permissionPromptTool: PERMISSION_PROMPT_TOOL }
    // Filled once the user's Codex servers are known; the Codex approval handler reads it.
    const mcpCover = new McpCoverage()
    const agent: BridgeAgent = {
      sessionId: this.deps.sessionId,
      agentId: run.agentId,
      role: 'worker',
      provider: row.provider
    }
    const common: CommonStartOptions = {
      agentId: run.agentId,
      role: 'worker',
      cwd: first.path,
      model: row.model,
      addDirs: [...trees.slice(1).map((t) => t.path), knowledgeDir, ...otherCheckouts],
      readOnlyDirs: [knowledgeDir, ...otherCheckouts],
      access: 'worker-write',
      // Codex asks Arc through this handler; Claude's prompts arrive through the bridge instead.
      approvals: createCodexApprovalHandler({
        agent,
        requestAction: (a, action, meta, call) =>
          this.deps.services.requestAction(a, action, meta, call),
        mcp: this.deps.personal?.mcp,
        covered: mcpCover
      }),
      instructions:
        prompt ??
        buildWorkerPrompt({
          groupName: this.deps.groupName(),
          number: row.number,
          slug: row.slug,
          task: row.task,
          command: row.command,
          branchName: first.project.branchName ?? `arc/${sessionSlug ?? 'session'}`,
          worktrees: trees.map((t) => ({ projectName: t.project.projectName, path: t.path })),
          provider: row.provider
        })
    }
    // The row says which provider runs the worker, for a fresh start and for a resume alike.
    const provider = row.provider
    // A Cursor command's file is read before anything starts: if it can't be read, no process is spawned.
    const firstMessage = resume
      ? resume.sessionId != null
        ? resume.message
        : resume.freshMessage
      : (row.command ?? row.task)
    const firstIsCommand = resume === undefined && row.command !== null
    const firstText = await this.expandCursorCommand(row, projects, firstMessage, firstIsCommand)
    const pluginViewDir =
      provider === 'claude' && this.deps.getPluginViewDir
        ? await this.pluginViewDir(projects.map((p) => p.projectPath))
        : undefined
    if (pluginViewDir) claude.pluginViewDir = pluginViewDir
    if (this.deps.bridge) {
      const registration = this.deps.bridge.registerAgent(agent, this.deps.services)
      common.bridge = { url: registration.url, token: registration.token }
      claude.mcpConfigPath = registration.configPath
      if (provider === 'claude' && this.deps.personal) {
        await this.applyPersonalClaude(
          claude,
          projects.map((p) => p.projectPath),
          registration.configPath
        )
      }
      common.extraEnv = { MCP_TOOL_TIMEOUT: WORKER_MCP_TOOL_TIMEOUT_MS }
      // The CLI calls request_permission itself; the model is not given it as a tool to call.
      common.bridgeTools = toolsForRole('worker')
        .filter((t) => t.name !== 'request_permission')
        .map((t) => t.name)
    }
    const codex: CodexStartOptions = {}
    if (provider === 'codex' && this.deps.personal) {
      const mcp = await this.deps.personal.codexMcp(first.path, 'workers')
      mcpCover.servers = applyCodexMcp(codex, mcp)
      if (mcp.degraded) this.noteDegradedMcp()
    }
    // The user's Cursor servers the Workers switch turned off: a no-op session entry each, and a deny entry.
    const cursor: CursorStartOptions = {}
    let cursorOff: string[] = []
    if (provider === 'cursor' && this.deps.personal?.cursorMcp) {
      try {
        cursorOff = applyCursorMcp(
          cursor,
          await this.deps.personal.cursorMcp(first.path, 'workers')
        )
      } catch (error: unknown) {
        this.deps.log.warn('could not read the Cursor MCP servers; none is switched off', error)
      }
    }
    let options: StartOptions
    switch (provider) {
      case 'claude':
        options = { ...common, provider: 'claude', claude }
        break
      case 'codex':
        options = { ...common, provider: 'codex', codex }
        break
      case 'cursor': {
        // Arc's deny file goes in before Cursor starts, so the user's allow rules cannot skip it.
        this.writeCursorDenyFiles(
          run.workerId,
          trees.map((t) => t.path),
          cursorOff
        )
        const personalMcp = this.deps.personal?.mcp
        const cwd = first.path
        options = {
          ...common,
          provider: 'cursor',
          cursor: {
            ...cursor,
            approvals: createCursorApprovalHandler({
              agent,
              requestAction: (a, action, meta, call) =>
                this.deps.services.requestAction(a, action, meta, call),
              offServers: () => new Set(cursorOff),
              ...(personalMcp ? { resolveMcp: (a) => personalMcp.cursorAction(a, cwd) } : {})
            }),
            onUnasked: (call) => this.noteUnasked(run, call)
          }
        }
        break
      }
      default:
        return assertNever(provider)
    }
    // A continued worker resumes its conversation; one that never stored a session id starts over with its task.
    const adapter = this.deps.registry.adapter(provider)
    const handle =
      resume?.sessionId != null
        ? await adapter.resume({ ...options, resume: { threadId: resume.sessionId } })
        : await adapter.start(options)
    run.handle = handle
    // Anything that fails once the process exists must not leave it running.
    try {
      const detachMcp = this.deps.personal?.mcp?.attachHandle(run.agentId, handle)
      void this.consume(run, handle, resume?.sessionId != null, common.instructions).finally(() =>
        detachMcp?.()
      )
      if (run.stopRequestedBy !== null) void handle.stop()
      const written = await this.sendFirst(
        handle,
        row,
        projects,
        firstText,
        firstIsCommand && firstText === firstMessage
      )
      if (!written) throw new Error('the worker process exited right away')
    } catch (error: unknown) {
      // The caller deletes the run and records the failure; the process's own exit must not overwrite it.
      run.handle = undefined
      void handle.stop()
      throw error
    }
  }

  /**
   * A Cursor command's text with its file read and expanded (Arc's instructions block comes before the
   * message, so the process is never given `/name`). Anything else is returned as it is.
   */
  private async expandCursorCommand(
    row: WorkerRow,
    projects: readonly SessionProjectRow[],
    message: string,
    isCommand: boolean
  ): Promise<string> {
    if (!isCommand || row.provider !== 'cursor' || !this.deps.cursorCommands) return message
    const name = commandName(message)
    if (name === null) return message
    const resolved = await this.deps.cursorCommands.resolve(
      name,
      message.replace(/^\/\S+/, '').trim(),
      projects.map((p) => p.projectPath)
    )
    if (!resolved.ok) throw new Error(resolved.message)
    return resolved.text
  }

  /**
   * The first message. A Codex worker does not read `/name` as a command, so its command is turned
   * into a skill input or the expanded prompt text. A Cursor command is expanded earlier
   * (`expandCursorCommand`), before the process starts; everything else is sent as it is.
   */
  private async sendFirst(
    handle: AgentHandle,
    row: WorkerRow,
    projects: readonly SessionProjectRow[],
    message: string,
    isCommand: boolean
  ): Promise<boolean> {
    if (!isCommand || row.provider !== 'codex' || !this.deps.codexCommands) {
      return handle.send(message)
    }
    const name = commandName(message)
    if (name === null) return handle.send(message)
    const args = message.replace(/^\/\S+/, '').trim()
    const run = await this.deps.codexCommands.resolve(
      name,
      args,
      projects.map((p) => p.projectPath)
    )
    if (!run.ok) throw new Error(run.message)
    if (run.kind === 'prompt') return handle.send(run.text)
    return handle.sendInput ? handle.sendInput(run.input) : handle.send(message)
  }

  // ---- terminal ----

  private logFor(workerId: string): TerminalLog {
    const existing = this.logs.get(workerId)
    if (existing) return existing
    const dir = this.deps.getTerminalDir?.()
    const log = new TerminalLog({
      workerId,
      path: dir === undefined ? undefined : join(dir, `${workerId}.log`),
      onChunk: (id, chunk) => this.host.emitTerminal?.(id, chunk),
      onError: (message, error) => this.deps.log.warn(message, error)
    })
    this.logs.set(workerId, log)
    return log
  }

  /** `workers:open-terminal` for a worker of this session. */
  openTerminal(workerId: string): Promise<TerminalBacklog> {
    return this.logFor(workerId).openBacklog(this.running.has(workerId))
  }

  // ---- events ----

  /** Once per session: the list of the user's Codex MCP servers could not be read, so their tool calls all ask. */
  private noteDegradedMcp(): void {
    if (this.degradedMcpNoted) return
    this.degradedMcpNoted = true
    this.host.logEvent('personal-mcp-unreadable', DEGRADED_MCP_NOTE)
  }

  /** One tracker per process run of a worker or resolver; its rows carry the worker's current snapshots. */
  private usageTracker(
    run: Running,
    handle: AgentHandle,
    usageRun: UsageRun
  ): UsageTracker | undefined {
    const usage = this.deps.usage
    if (usage === undefined) return undefined
    const row = (): WorkerRow | undefined => this.deps.workersRepo.get(run.workerId)
    return usage.track(
      {
        sessionId: this.deps.sessionId,
        agentKey: run.resolver ? `resolver:${run.workerId}` : run.workerId,
        role: run.resolver ? 'resolver' : 'worker',
        workerId: run.workerId,
        workerLabel: `W${run.number}`,
        command: row()?.command ?? null,
        provider: () => row()?.provider ?? handle.provider,
        model: () => row()?.model ?? '',
        readContext: () => {
          const trees = this.deps.worktreesRepo.listByWorker(run.workerId)
          return {
            cwd: trees.find((t) => t.removedAt === null)?.path ?? null,
            roots: [
              ...trees.map((t) => rootOf(t.path)),
              ...this.deps.sessionProjectsRepo
                .listBySession(this.deps.sessionId)
                .map((p) => ({ path: p.projectPath, name: safeDirName(p.projectName) }))
            ]
          }
        }
      },
      usageRun
    )
  }

  private async consume(
    run: Running,
    handle: AgentHandle,
    resumed: boolean,
    instructions: string | undefined
  ): Promise<void> {
    const log = this.logFor(run.workerId)
    const usage = this.usageTracker(run, handle, { resumed, instructions })
    try {
      for await (const event of handle.events) {
        log.event(event)
        // A process whose start failed was dropped by `launch`: its exit says nothing about the worker.
        if (run.handle !== handle) continue
        // A recorded turn, or a request of the running one, changes the worker's token total: the card gets it with the next push.
        if (usage?.onEvent(event)) this.schedulePush(run.workerId)
        await this.onEvent(run, handle, event)
      }
    } catch (error: unknown) {
      this.deps.log.error(`worker W${run.number} event loop failed`, error)
    }
  }

  private async onEvent(run: Running, handle: AgentHandle, event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'session':
        if (event.model) this.host.learnModel({ provider: event.provider, model: event.model })
        this.deps.workersRepo.setProvider(run.workerId, event.provider, this.deps.now())
        this.deps.workersRepo.setProviderSessionId(
          run.workerId,
          event.providerSessionId,
          this.deps.now()
        )
        this.setStatus(run, 'working', 'Working')
        return
      case 'text-delta':
      case 'thinking-delta':
      case 'assistant-message':
        // The parent itself is active again: the follow-up turn started.
        if (event.parentToolUseId === undefined) this.clearHelperSettle(run)
        return
      case 'tool-use':
        if (event.parentToolUseId === undefined) this.clearHelperSettle(run)
        if (event.parentToolUseId !== undefined) this.rememberHelperTool(run, event.toolUseId)
        // Arc's own bridge tools and ToolSearch are plumbing; report_progress sets the note itself.
        if (event.name.startsWith('mcp__arc__') || event.name === 'ToolSearch') return
        this.setActivity(run, event.summary)
        return
      case 'task-started':
        // `background_tasks_changed` usually comes first; adding twice is harmless.
        this.setHelpers(run, new Set([...run.helpers, event.taskId]))
        return
      case 'task-ended':
        this.setHelpers(run, new Set([...run.helpers].filter((id) => id !== event.taskId)))
        return
      case 'tasks-changed':
        this.setHelpers(run, new Set(event.tasks.map((t) => t.taskId)))
        return
      case 'turn-result':
        await this.onTurnResult(run, handle, event.ok, event.interrupted)
        return
      case 'error':
        this.onError(run, event.kind, event.message)
        return
      case 'rate-limit':
        forwardRateLimit(this.deps.planUsage, event)
        if (event.status === 'rejected') this.onRateLimit(run, event.resetsAt, event.provider)
        return
      case 'exit':
        await this.finalize(run, event)
        return
      case 'turn-started':
        // A turn the user's lines started (Codex queues them, so a later one starts after the last ended).
        if (run.controlActive && !run.controlReplying) {
          run.controlReplying = true
          this.pushNow(run.workerId)
        }
        return
      case 'tool-result':
      case 'stderr':
      case 'usage':
      case 'usage-progress':
      case 'control-ack':
      case 'approval':
      case 'plan-updated':
      case 'model-rerouted':
      case 'mcp-status':
      case 'user-input-request':
      case 'unknown':
        return
      default: {
        const exhaustive: never = event
        void exhaustive
      }
    }
  }

  private async onTurnResult(
    run: Running,
    handle: AgentHandle,
    ok: boolean,
    interrupted: boolean
  ): Promise<void> {
    // Decided before the first await: a turn that ends because of Arc's own interrupt, or while the
    // user is in control, is never judged (no nudge, no failure, no stop).
    const ours = interrupted && run.ignoreInterrupted
    if (interrupted) run.ignoreInterrupted = false
    if (ours || run.controlActive) {
      if (run.controlActive && !ours && run.controlReplying) {
        run.controlReplying = false
        this.pushNow(run.workerId)
      }
      await this.recordHeads(run)
      return
    }
    const limited = run.rateLimited
    await this.recordHeads(run)
    if (run.stopRequestedBy !== null) return
    // The plan refusal already ended this worker: no nudge for a report_done it can never send.
    if (run.failReason !== null) return
    // A turn that ended on the usage limit is not "forgot report_done": wait for the retry.
    if (limited || run.rateLimited) return
    // Background helpers keep running after the turn ends (spike S1, Q5): the worker is not idle,
    // forgotten or done. The CLI starts a follow-up turn when they finish; that one is judged.
    if (run.helpers.size > 0 && !run.helperCapped) {
      run.deferredTurn = { ok }
      return
    }
    run.deferredTurn = null
    this.clearHelperSettle(run)
    await this.settleTurn(run, handle, ok)
  }

  /** What a finished turn means for the worker: stop after report_done, else nudge once, else fail. */
  private async settleTurn(run: Running, handle: AgentHandle, ok: boolean): Promise<void> {
    // The helper timers call this directly, so the guard lives here too.
    if (run.controlActive) return
    if (run.reportedDone) {
      run.sawResult = ok || run.sawResult
      // The CLI stays up waiting for more input; closing stdin ends it cleanly (exit 0).
      void handle.stop()
      return
    }
    if (!run.nudged) {
      run.nudged = true
      await handle.send(
        '[Arc] You have not called report_done. Commit your work in the working copy and call report_done with a short summary.'
      )
      return
    }
    run.failReason = 'The worker ended its turn twice without calling report_done.'
    void handle.stop()
  }

  private rememberHelperTool(run: Running, toolUseId: string): void {
    run.helperToolIds.add(toolUseId)
    if (run.helperToolIds.size > HELPER_TOOL_IDS_MAX) {
      const oldest = run.helperToolIds.values().next().value
      if (oldest !== undefined) run.helperToolIds.delete(oldest)
    }
  }

  /** The CLI's running helpers changed: update the count shown, the activity line and the cap timer. */
  private setHelpers(run: Running, next: Set<string>): void {
    const before = run.helpers.size
    run.helpers = next
    if (next.size === 0) {
      this.clearHelperCap(run)
      run.helperCapped = false
      if (before > 0 && run.deferredTurn !== null) this.startHelperSettle(run)
    } else if (before === 0 && run.helperCapTimer === undefined && !run.helperCapped) {
      this.startHelperCap(run)
    }
    if (next.size !== before) {
      this.setActivity(run, run.activityBase, true)
      this.pushNow(run.workerId)
      this.host.onChange()
    }
  }

  private startHelperCap(run: Running): void {
    const timer = setTimeout(() => {
      void this.onHelperCap(run)
    }, this.deps.helperCapMs ?? HELPER_CAP_MS)
    timer.unref()
    run.helperCapTimer = timer
  }

  private clearHelperCap(run: Running): void {
    if (run.helperCapTimer) clearTimeout(run.helperCapTimer)
    run.helperCapTimer = undefined
  }

  private clearHelperSettle(run: Running): void {
    if (run.helperSettleTimer) clearTimeout(run.helperSettleTimer)
    run.helperSettleTimer = undefined
  }

  /** The helpers are over and a turn waits: if the CLI starts no follow-up turn, settle it anyway. */
  private startHelperSettle(run: Running): void {
    this.clearHelperSettle(run)
    const timer = setTimeout(() => {
      void this.onHelperSettle(run)
    }, this.deps.helperSettleMs ?? HELPER_SETTLE_MS)
    timer.unref()
    run.helperSettleTimer = timer
  }

  private async onHelperSettle(run: Running): Promise<void> {
    run.helperSettleTimer = undefined
    const deferred = run.deferredTurn
    if (!deferred || !this.running.has(run.workerId) || run.helpers.size > 0) return
    run.deferredTurn = null
    this.host.logEvent(
      'helpers-settled',
      `Helpers finished and W${run.number} started no follow-up turn within ${capText(this.deps.helperSettleMs ?? HELPER_SETTLE_MS)}; finishing`,
      undefined,
      run.workerId
    )
    if (run.handle && run.stopRequestedBy === null) {
      await this.settleTurn(run, run.handle, deferred.ok)
    }
  }

  /** The helpers outlived the cap: stop waiting and handle the worker as if they were not there. */
  private async onHelperCap(run: Running): Promise<void> {
    run.helperCapTimer = undefined
    if (!this.running.has(run.workerId) || run.helpers.size === 0) return
    run.helperCapped = true
    this.host.logEvent(
      'helpers-timeout',
      `Helpers still running after ${capText(this.deps.helperCapMs ?? HELPER_CAP_MS)}; stopping W${run.number}`,
      undefined,
      run.workerId
    )
    const deferred = run.deferredTurn
    run.deferredTurn = null
    if (deferred && run.handle && run.stopRequestedBy === null) {
      await this.settleTurn(run, run.handle, deferred.ok)
    }
  }

  private onError(
    run: Running,
    kind: Extract<AgentEvent, { type: 'error' }>['kind'],
    message: string
  ): void {
    this.deps.log.warn(`worker W${run.number} error (${kind}): ${message}`)
    if (kind === 'auth') this.host.onSignedOut()
    if (kind === 'rate-limit') this.onRateLimit(run, undefined, run.handle?.provider)
    if (kind === 'plan-refused') this.onPlanRefused(run)
  }

  /**
   * The provider's plan does not include the worker's model, so waiting would not help. The worker
   * fails with a sentence that names the model and the brain is told, like any failed worker; it
   * does not silently move to another model.
   */
  private onPlanRefused(run: Running): void {
    if (run.stopRequestedBy !== null || run.failReason !== null) return
    const row = this.deps.workersRepo.get(run.workerId)
    if (!row) return
    run.failReason = planRefusedText({ provider: row.provider, model: row.model })
    void run.handle?.stop()
  }

  /**
   * The worker hit the usage limit: it waits (activity line, paused queue) and is retried once after
   * the reset. Never signed-out, never failed.
   */
  private onRateLimit(
    run: Running,
    resetsAt: number | undefined,
    provider: ProviderId | undefined
  ): void {
    if (run.stopRequestedBy !== null) return
    run.rateLimited = true
    this.setActivity(run, 'Waiting for limit', true)
    this.host.rateLimit.hit(run.agentId, {
      resetsAt,
      provider,
      workerId: run.workerId,
      retry: () => this.retryAfterLimit(run.workerId)
    })
  }

  /** The wait is over. A live process just gets "Continue."; one that exited meanwhile is resumed. */
  private async retryAfterLimit(workerId: string): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (!row || this.disposed || this.stopping) return
    if (row.status !== 'working' && row.status !== 'starting') return
    const run = this.running.get(workerId)
    if (run?.handle) {
      run.rateLimited = false
      this.setActivity(run, 'Working', true)
      await run.handle.send('Continue.')
      return
    }
    await this.relaunch(row, 'Continue.', [])
  }

  private async finalize(
    run: Running,
    event: Extract<AgentEvent, { type: 'exit' }>
  ): Promise<void> {
    if (!this.running.has(run.workerId)) return
    this.running.delete(run.workerId)
    this.clearHelperCap(run)
    this.clearHelperSettle(run)
    run.helpers = new Set()
    await this.recordHeads(run)
    if (run.controlActive && (run.stopRequestedBy === null || run.stopRequestedBy === 'quit')) {
      // The process ended while the user was in control (the interrupt escalated to a kill, it
      // crashed, or Arc quit): the worker is paused, not failed or stopped. The next typed line
      // resumes it.
      run.controlReplying = false
      this.deps.workersRepo.setControl(run.workerId, 'paused', this.deps.now())
      this.logFor(run.workerId).finish('Paused')
      this.deps.bridge?.revokeAgent(run.agentId)
      this.pushNow(run.workerId)
      this.host.onChange()
      run.markFinished()
      return
    }
    if (run.rateLimited && run.stopRequestedBy === null && !run.reportedDone) {
      // The process ended while the worker waited for the usage limit: keep it Working ("Waiting for
      // limit"); the scheduled retry resumes it with --resume.
      this.logFor(run.workerId).status('Waiting for limit')
      this.deps.bridge?.revokeAgent(run.agentId)
      this.pushNow(run.workerId)
      run.markFinished()
      return
    }
    const row = this.deps.workersRepo.get(run.workerId)
    // The user's own Stop ends their control too.
    if (run.stopRequestedBy === 'user' && row?.userControl) this.clearControl(run.workerId)
    const label = run.resolver
      ? 'Conflict resolver'
      : row
        ? labelOf(row)
        : `W${run.number} ${run.slug}`
    const outcome = classifyWorkerExit({
      code: event.code,
      signal: event.signal,
      expected: event.expected,
      stderrTail: event.stderrTail,
      stopRequestedBy: run.stopRequestedBy,
      reportedDone: run.reportedDone,
      sawResult: run.sawResult
    })
    const now = this.deps.now()
    this.logFor(run.workerId).finish(
      outcome.status === 'done'
        ? 'Done'
        : outcome.status === 'stopped'
          ? 'Stopped'
          : `Failed: ${run.failReason ?? outcome.reason}`
    )
    if (outcome.status === 'done') {
      if (!run.resolver) await this.suggestLighterModel(run, row)
      this.deps.workersRepo.setStatus(run.workerId, 'done', now)
      this.deps.workersRepo.setActivity(run.workerId, null, now)
      this.host.logEvent('worker-done', `${label} finished`, undefined, run.workerId)
      if (!run.resolver && !(this.host.onWorkerDone?.(run.workerId) ?? false)) {
        this.host.notifyBrain(`[Arc] ${label} finished: ${row?.summary ?? 'no summary'}`)
      }
    } else if (
      outcome.status === 'stopped' &&
      outcome.stoppedBy === 'quit' &&
      alreadyStoredForQuit(row)
    ) {
      // The quit sequence stored Stopped (or left a waiting worker's status) before the kill.
      this.deps.workersRepo.setActivity(run.workerId, null, now)
    } else if (outcome.status === 'stopped') {
      // Only the user's Stop throws the working copy away; a stop from quitting or a crash keeps it.
      const discarded =
        outcome.stoppedBy === 'user' && !run.resolver
          ? await this.discardWorkingCopies(run.workerId)
          : null
      this.deps.workersRepo.setStatus(run.workerId, 'stopped', now, outcome.stoppedBy)
      this.deps.workersRepo.setActivity(run.workerId, null, now)
      this.host.logEvent(
        'worker-stopped',
        outcome.stoppedBy === 'user'
          ? `Stopped by you${discarded?.removed ? `; working copy removed${discardNote(discarded.unmerged)}` : ''}`
          : `${label} stopped when Arc quit`,
        discarded ? { unmergedCommits: discarded.unmerged } : undefined,
        run.workerId
      )
    } else {
      const reason = run.failReason ?? outcome.reason
      this.deps.workersRepo.setFailure(run.workerId, reason, now)
      this.deps.workersRepo.setActivity(run.workerId, null, now)
      this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, run.workerId)
      if (!run.resolver) {
        this.host.notifyBrain(
          `[Arc] Worker W${run.number} failed: ${reason.replace(/\.$/, '')}. Decide how to continue and tell the user.`
        )
      }
    }
    this.deps.bridge?.revokeAgent(run.agentId)
    this.pushNow(run.workerId)
    this.host.onChange()
    run.markFinished()
    this.drain()
  }

  /**
   * A worker is Done: lets the suggestions judge its model against the task. Counts the files it
   * changed in its working copies (committed or not) before a merge can remove them.
   */
  private async suggestLighterModel(run: Running, row: WorkerRow | undefined): Promise<void> {
    const usage = this.deps.usage
    if (usage === undefined || row === undefined) return
    try {
      const trees = this.deps.worktreesRepo
        .listByWorker(run.workerId)
        .filter((t) => t.removedAt === null)
      let changedFiles: number | null = null
      if (trees.length > 0) {
        changedFiles = 0
        for (const tree of trees) {
          changedFiles += (await this.deps.worktreeGit.changedFiles(tree.path, tree.baseSha)).length
        }
      }
      usage.workerFinished({
        sessionId: this.deps.sessionId,
        agentKey: run.workerId,
        workerId: run.workerId,
        label: `W${run.number}`,
        provider: row.provider,
        model: row.model,
        changedFiles
      })
    } catch (error: unknown) {
      this.deps.log.warn(`could not check the model of W${run.number}`, error)
    }
  }

  // ---- state helpers ----

  private setStatus(run: Running, status: WorkerStatus, activity: string): void {
    const row = this.deps.workersRepo.get(run.workerId)
    if (!row || row.status === status) return
    if (row.status !== 'starting') return
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(run.workerId, status, now)
    this.deps.workersRepo.setActivity(run.workerId, activity, now)
    this.logFor(run.workerId).status(activity)
    this.schedulePush(run.workerId)
    this.host.onChange()
  }

  private setActivity(run: Running, activity: string, force = false): void {
    const now = this.deps.now()
    if (!force && now - run.lastActivityAt < ACTIVITY_MS) return
    run.lastActivityAt = now
    const base = activity.slice(0, 200)
    run.activityBase = base
    const helpers = run.helpers.size
    const shown = helpers > 0 ? `${base} (${helpers} helper${helpers === 1 ? '' : 's'})` : base
    this.deps.workersRepo.setActivity(run.workerId, shown, now)
    this.schedulePush(run.workerId)
  }

  private recordHeads(run: Running): Promise<void> {
    if (run.resolver) return run.recordChain
    run.recordChain = run.recordChain
      .then(() => this.doRecordHeads(run.workerId))
      .catch(() => undefined)
    return run.recordChain
  }

  /** Stores each worktree's HEAD sha and the commits made since its base. */
  private async doRecordHeads(workerId: string): Promise<void> {
    const known = new Set(this.deps.commitsRepo.listByWorker(workerId).map((c) => c.sha))
    for (const tree of this.deps.worktreesRepo.listByWorker(workerId)) {
      if (tree.removedAt !== null) continue
      try {
        const head = await this.deps.worktreeGit.headSha(tree.path)
        if (head !== tree.headSha) this.deps.worktreesRepo.setHeadSha(tree.id, head)
        for (const commit of await this.deps.worktreeGit.commitsSince(tree.path, tree.baseSha)) {
          if (known.has(commit.sha)) continue
          known.add(commit.sha)
          this.deps.commitsRepo.add({
            workerId,
            projectId: tree.projectId,
            sha: commit.sha,
            subject: commit.subject,
            committedAt: commit.committedAt
          })
        }
      } catch (error: unknown) {
        this.deps.log.warn(`could not read the commits of ${tree.path}`, error)
      }
    }
  }

  // ---- attention (permission requests and questions) ----

  /** The session's checkouts the worker does not work in: it may read them and must not change them. */
  private otherCheckouts(ownPaths: ReadonlySet<string>): string[] {
    return this.deps.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .filter((p) => !ownPaths.has(p.projectPath))
      .map((p) => p.projectPath)
  }

  /**
   * Writes Arc's deny file into a Cursor worker's working copies (tech spec 2.4), then brings the
   * files of the other live Cursor workers up to date, since this worker's copies are new to them.
   * It throws when the worker's own file cannot be written; the others are best effort.
   */
  private writeCursorDenyFiles(
    workerId: string,
    trees: readonly string[],
    offMcp: readonly string[] = []
  ): void {
    this.cursorTrees.set(workerId, [...trees])
    this.cursorOffMcp.set(workerId, [...offMcp])
    for (const [id, paths] of this.cursorTrees) {
      if (id !== workerId && !this.running.has(id)) continue
      try {
        this.writeCursorDenyFor(id, paths)
      } catch (error: unknown) {
        if (id === workerId) throw error
        this.deps.log.warn(`could not refresh the Cursor deny file of ${id}`, error)
      }
    }
  }

  private writeCursorDenyFor(workerId: string, trees: readonly string[]): void {
    const sessionId = this.deps.sessionId
    const denyDirs = [
      ...this.deps.sessionProjectsRepo.listBySession(sessionId).map((p) => p.projectPath),
      this.deps.getKnowledgeDir(),
      ...this.deps.worktreesRepo
        .listBySession(sessionId)
        .filter((t) => t.removedAt === null && t.workerId !== workerId)
        .map((t) => t.path)
    ]
    for (const worktree of trees) {
      const result = writeCursorDeny({
        worktree,
        ownWorktrees: trees,
        denyDirs,
        offMcp: this.cursorOffMcp.get(workerId) ?? []
      })
      if (!result.written) {
        this.deps.log.info(
          `${worktree} commits its own .cursor/cli.json, so Arc left it alone and relies on approvals`
        )
      }
    }
  }

  /** A Cursor tool call that completed without asking: blocked, ran unasked, or an edit outside the working copy. */
  private noteUnasked(run: Running, call: CursorToolCall): void {
    const note = classifyUnaskedCall(call, this.policyContext(run.workerId))
    if (!note) return
    this.host.logEvent(
      'cursor-blocked',
      cursorBlockedText(`W${run.number} (Cursor)`, note),
      { workerId: run.workerId, action: note.action, outcome: note.outcome, kind: note.kind },
      run.workerId
    )
  }

  /** "W1 api-retry", or "W2 · /awos:spec" for a worker that runs a command. */
  workerLabel(workerId: string): string {
    const row = this.deps.workersRepo.get(workerId)
    return row ? labelOf(row) : 'A worker'
  }

  /** The worker a bridge call came from. */
  workerOf(agent: BridgeAgent): { id: string; number: number; slug: string } {
    const run = this.runOf(agent)
    return { id: run.workerId, number: run.number, slug: run.slug }
  }

  /** Where the worker may write (its working copies) and what it may only read, for the classifier. */
  policyContext(workerId: string): ClassifyContext {
    const row = this.deps.workersRepo.get(workerId)
    const roots = this.deps.worktreesRepo
      .listByWorker(workerId)
      .filter((t) => t.removedAt === null)
      .map((t) => t.path)
    const wanted = new Set(row ? parseIds(row.projectIdsJson) : [])
    const own = new Set(
      this.deps.sessionProjectsRepo
        .listBySession(this.deps.sessionId)
        .filter((p) => p.projectId !== null && wanted.has(p.projectId))
        .map((p) => p.projectPath)
    )
    return {
      worktreeRoots: roots,
      // The worker's own project checkouts too: they stay protected even when one sits in the temp folder.
      readOnlyDirs: [this.deps.getKnowledgeDir(), ...this.otherCheckouts(own), ...own],
      ...(roots[0] === undefined ? {} : { cwd: roots[0] })
    }
  }

  /**
   * A worker waits on a request (needs_approval, has_question) or is back at work. Only a worker
   * that is still alive changes: a finished, failed or stopped one keeps its status.
   */
  setAttentionStatus(
    workerId: string,
    status: 'needs_approval' | 'has_question' | 'working'
  ): void {
    const row = this.deps.workersRepo.get(workerId)
    if (!row) return
    const live = ['starting', 'working', 'needs_approval', 'has_question']
    if (!live.includes(row.status) || row.status === status) return
    if (status === 'working' && row.status !== 'needs_approval' && row.status !== 'has_question') {
      return
    }
    const now = this.deps.now()
    if (status === 'working' && !this.running.has(workerId) && row.userControl !== null) {
      // The user answered in the terminal of a worker they are in control of, after a restart: the
      // answer resumes it, and the user stays in control. Without a working copy it stays paused.
      if (!this.stopping && !this.disposed && this.cannotLaunch(row) === null) {
        this.deps.workersRepo.setControl(workerId, 'active', now)
        void this.relaunch(row, null, this.host.undeliveredAnswers(workerId), { control: true })
      }
      return
    }
    if (status === 'working' && !this.running.has(workerId)) {
      // The process is gone (Arc was restarted while it waited): the answer resumes the worker with
      // --resume and reaches it as a user turn. Without a working copy to resume in (or while Arc
      // quits) it is a stopped worker, and the answer stays stored for a later Continue.
      const stillPossible = !this.stopping && !this.disposed && this.cannotLaunch(row) === null
      if (stillPossible) {
        void this.relaunch(row, null, this.host.undeliveredAnswers(workerId))
        return
      }
      this.deps.workersRepo.setStatus(workerId, 'stopped', now, 'quit')
      this.deps.workersRepo.setActivity(workerId, null, now)
      this.pushNow(workerId)
      this.host.onChange()
      return
    }
    this.deps.workersRepo.setStatus(workerId, status, now)
    this.deps.workersRepo.setActivity(
      workerId,
      status === 'needs_approval'
        ? 'Waiting for approval'
        : status === 'has_question'
          ? 'Waiting for an answer'
          : 'Working',
      now
    )
    this.pushNow(workerId)
    this.host.onChange()
  }

  // ---- continue (tech spec 2.10) ----

  /** Why a worker's process cannot be started again in its working copy; null when it can. */
  private cannotLaunch(row: WorkerRow): string | null {
    if (isResolverRow(row)) return 'A conflict resolver cannot be continued.'
    const trees = this.deps.worktreesRepo.listByWorker(row.id).filter((t) => t.removedAt === null)
    if (trees.length === 0 || trees.some((t) => !existsSync(t.path))) {
      return 'Its working copy is gone, so there is nothing to continue in.'
    }
    const projects = this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)
    if (
      trees.some((t) => !projects.some((p) => p.projectId !== null && p.projectId === t.projectId))
    ) {
      return 'A project of this worker is no longer in the session.'
    }
    return null
  }

  /** Why `workers:continue` refuses this worker; null when it can be continued. */
  continueReason(row: WorkerRow): string | null {
    if (row.removedAt !== null) return 'This worker was removed.'
    if (this.running.has(row.id)) return 'This worker is already running.'
    if (row.status !== 'stopped') {
      return `Only a stopped worker can be continued; this one is ${row.status.replace('_', ' ')}.`
    }
    if (row.stoppedBy !== 'quit' && row.stoppedBy !== 'crash') {
      return 'You stopped this worker, which removed its working copy, so it cannot be continued.'
    }
    return this.cannotLaunch(row)
  }

  /** Workers `workers:continue` with `all` would continue, and the Continue prompt offers. */
  continuable(): WorkerRow[] {
    return this.deps.workersRepo
      .listBySession(this.deps.sessionId)
      .filter((w) => this.continueReason(w) === null)
  }

  /** `workers:continue` for one worker. Throws `VALIDATION_FAILED` with the reason. */
  async continueWorker(workerId: string): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (row?.sessionId !== this.deps.sessionId) throw new AppErrorException('VALIDATION_FAILED')
    const reason = this.continueReason(row)
    if (reason !== null) throw new AppErrorException('VALIDATION_FAILED', { reason })
    await this.relaunch(
      row,
      'You were interrupted. Continue the task.',
      this.host.undeliveredAnswers(workerId)
    )
  }

  /**
   * Starts the process of a worker that has none (stopped by a quit or crash, paused on a request
   * that was answered after a restart, or waiting for the usage limit) in its existing working copy:
   * `--resume <claude session id>`, same model, a fresh bridge token. `lead` is the first line of the
   * user turn (null for a worker that was not interrupted, only answered); the answers follow it.
   * A worker that never stored a session id starts over with its original task instead.
   */
  private async relaunch(
    row: WorkerRow,
    lead: string | null,
    answers: readonly AttentionRequestRow[],
    options: { control?: boolean; leadOnFresh?: boolean } = {}
  ): Promise<void> {
    const workerId = row.id
    const label = labelOf(row)
    if (row.provider !== 'claude') {
      // The conversation lives with the provider: without it the worker waits, it never moves.
      const unavailable = await this.providerBlockReason(row.provider, true)
      if (unavailable !== null) {
        this.keepStopped(row, unavailable)
        return
      }
    }
    const trees = this.deps.worktreesRepo
      .listByWorker(workerId)
      .filter((t) => t.removedAt === null)
      .map((t) => ({
        path: t.path,
        project: this.deps.sessionProjectsRepo
          .listBySession(this.deps.sessionId)
          .find((p) => p.projectId !== null && p.projectId === t.projectId)
      }))
      .filter((t): t is { path: string; project: SessionProjectRow } => t.project !== undefined)
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(workerId, 'starting', now)
    this.deps.workersRepo.setActivity(workerId, 'Starting', now)
    this.host.logEvent(
      'worker-continued',
      `Continuing ${label}`,
      { resumed: row.providerSessionId !== null },
      workerId
    )
    this.pushNow(workerId)
    this.host.onChange()

    const notes = answers.map(answerNote)
    const message = [...(lead === null ? [] : [lead]), ...notes].join('\n\n') || 'Continue.'
    const run = this.makeRunning(row)
    // The user is (again) in control: the new process is judged like a controlled one from its start.
    if (options.control) {
      run.controlActive = true
      run.controlReplying = true
    }
    if (this.stopping) run.stopRequestedBy = 'quit'
    this.running.set(workerId, run)
    const sessionRow = this.deps.sessionsRepo.getById(this.deps.sessionId)
    try {
      await this.launch(
        run,
        row,
        trees,
        sessionRow?.slug ?? null,
        trees.map((t) => t.project),
        undefined,
        {
          sessionId: row.providerSessionId,
          message,
          freshMessage: [
            row.command ?? row.task,
            ...(options.leadOnFresh && lead !== null ? [lead] : []),
            ...notes
          ].join('\n\n')
        }
      )
      this.host.markDelivered(answers.map((a) => a.id))
    } catch (error: unknown) {
      if (error instanceof ProviderUnavailableError && row.provider !== 'claude') {
        // The provider refused the resume at the handshake although its status said ok.
        this.running.delete(workerId)
        this.deps.bridge?.revokeAgent(run.agentId)
        this.noteProviderDown(row.provider, error.reason)
        this.logFor(workerId).finish(
          workerCannotContinueText(fallbackLabel(row), error.reason, row.provider)
        )
        this.keepStopped(row, error.reason)
        run.markFinished()
        this.drain()
        return
      }
      this.running.delete(workerId)
      this.deps.bridge?.revokeAgent(run.agentId)
      const reason =
        error instanceof ProviderHistoryMissingError
          ? `The ${providerName(error.provider)} history for W${row.number} is gone.`
          : `The worker could not be continued: ${error instanceof Error ? error.message : String(error)}`
      this.logFor(workerId).finish(`Failed: ${reason}`)
      this.deps.log.error(`worker ${label}: ${reason}`)
      this.deps.workersRepo.setFailure(workerId, reason, this.deps.now())
      this.deps.workersRepo.setActivity(workerId, null, this.deps.now())
      this.host.logEvent('worker-failed', `${label} failed: ${reason}`, undefined, workerId)
      this.pushNow(workerId)
      this.host.onChange()
      run.markFinished()
      this.drain()
    }
  }

  // ---- tool calls from workers ----

  private runOf(agent: BridgeAgent): Running {
    for (const run of this.running.values()) if (run.agentId === agent.agentId) return run
    throw new BridgeToolError('unknown_worker', 'This worker is not running.')
  }

  reportProgress(agent: BridgeAgent, input: ReportProgressInput): { ok: true } {
    const run = this.runOf(agent)
    run.lastReport = input.note
    if (input.filesChanged) {
      for (const f of input.filesChanged) if (!run.files.includes(f)) run.files.push(f)
    }
    this.setActivity(run, input.note, true)
    return { ok: true }
  }

  async reportDone(agent: BridgeAgent, input: ReportDoneInput): Promise<{ ok: true }> {
    const run = this.runOf(agent)
    await this.recordHeads(run)
    run.reportedDone = true
    run.lastReport = input.summary
    this.deps.workersRepo.setSummary(
      run.workerId,
      input.summary.slice(0, SUMMARY_MAX),
      this.deps.now()
    )
    this.setActivity(run, 'Finishing', true)
    return { ok: true }
  }

  async message(
    ref: string,
    text: string
  ): Promise<{ delivered: boolean; queued?: boolean | undefined }> {
    const row = this.resolveRef(ref)
    if (!row) throw new BridgeToolError('unknown_worker', `No worker "${ref}" in this session.`)
    // The user is in control (even paused, with no process): nothing reaches the worker's input
    // until hand-back, so the user's line and the brain's never interleave.
    if (row.userControl !== null) {
      this.deps.heldMessagesRepo.enqueue(row.id, this.deps.sessionId, text, this.deps.now())
      return { delivered: false, queued: true }
    }
    const run = this.running.get(row.id)
    if (!run?.handle) {
      throw new BridgeToolError('worker_not_running', `W${row.number} ${row.slug} is not running.`)
    }
    return { delivered: await run.handle.send(`${BRAIN_MESSAGE_PREFIX}${text}`) }
  }

  // ---- stepping in (spec 006, tech spec 2.4) ----

  /** True while the user is in control of the worker (stepped in or paused). */
  isControlled(workerId: string): boolean {
    return this.deps.workersRepo.get(workerId)?.userControl != null
  }

  /** True when the user may step in on this worker. */
  canStepIn(row: WorkerRow): boolean {
    return (
      STEPPABLE.includes(row.status) &&
      row.removedAt === null &&
      !isResolverRow(row) &&
      row.userControl === null
    )
  }

  private controlledRow(workerId: string): WorkerRow {
    const row = this.deps.workersRepo.get(workerId)
    if (row?.sessionId !== this.deps.sessionId || row.userControl === null) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    return row
  }

  /** Ends the control columns and forgets the step-in base of every working copy. */
  private clearControl(workerId: string): void {
    this.deps.workersRepo.endControl(workerId, this.deps.now())
    this.deps.worktreesRepo.clearControlBase(workerId)
  }

  /** `workers:step-in`. The order matters: control is stored before the interrupt is sent. */
  async stepIn(workerId: string): Promise<void> {
    const found = this.deps.workersRepo.get(workerId)
    if (found?.sessionId !== this.deps.sessionId || !this.canStepIn(found)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const run = this.running.get(workerId)
    // 1. The heads, and each live working copy's HEAD as the base of the hand-back summary.
    await this.doRecordHeads(workerId)
    if (this.deps.workersRepo.get(workerId)?.userControl !== null) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    for (const tree of this.deps.worktreesRepo.listByWorker(workerId)) {
      if (tree.removedAt === null) this.deps.worktreesRepo.setControlBase(tree.id, tree.headSha)
    }
    // 2. Control is stored and flagged before anything can end the current turn.
    this.deps.workersRepo.beginControl(workerId, 'active', this.deps.now())
    if (run) {
      run.controlActive = true
      run.controlReplying = false
      // 3. Nothing may settle the worker, and the usage-limit retry must not resume it behind the user.
      run.deferredTurn = null
      run.rateLimited = false
      this.clearHelperCap(run)
      this.clearHelperSettle(run)
    }
    this.host.rateLimit.cancel(`worker-${workerId}`)
    this.holdQueuedSends(workerId, run)
    this.pushNow(workerId)
    // 4. Stop the current step. No process, or one that did not survive: paused until the next line.
    const outcome = run?.handle ? await this.interruptRun(run) : 'killed'
    if (outcome === 'killed') {
      this.deps.workersRepo.setControl(workerId, 'paused', this.deps.now())
    }
    // 5. Requests that were waiting for the user now wait in the terminal; their calls stay blocked.
    this.host.routeAttentionToTerminal(workerId)
    const label = labelOf(found)
    this.logFor(workerId).marker('You stepped in')
    this.host.logEvent('user-control', `You stepped in on ${label}`, undefined, workerId)
    this.host.notifyBrain(stepInNote(label))
    this.pushNow(workerId)
    this.host.onChange()
  }

  /**
   * Sends the adapter queued behind the running turn (Codex starts them one after another) would
   * start turns in the user's hands once the interrupt ends the current one. The brain's messages
   * among them are held until hand-back; anything else (a nudge) is stale and dropped.
   */
  private holdQueuedSends(workerId: string, run: Running | undefined): void {
    for (const text of run?.handle?.discardQueuedSends?.() ?? []) {
      if (!text.startsWith(BRAIN_MESSAGE_PREFIX)) continue
      this.deps.heldMessagesRepo.enqueue(
        workerId,
        this.deps.sessionId,
        text.slice(BRAIN_MESSAGE_PREFIX.length),
        this.deps.now()
      )
    }
  }

  /** Interrupts the run's current turn; the interrupted result that follows is Arc's own. */
  private async interruptRun(run: Running): Promise<InterruptOutcome> {
    const outcome = (await run.handle?.interrupt()) ?? 'killed'
    if (outcome === 'acked' || outcome === 'sigint') run.ignoreInterrupted = true
    run.controlReplying = false
    return outcome
  }

  /** `workers:send-input`: the user's line, verbatim, as a user turn of the worker. */
  async sendInput(workerId: string, text: string): Promise<void> {
    const row = this.controlledRow(workerId)
    // Codex does not read slash text as a command: it is answered here, not sent as a literal `/foo`.
    let skillInput: CodexInput[] | undefined
    if (row.provider === 'codex') {
      const name = typedSlashName(text)
      if (name !== null) {
        const skill = await this.deps.codexCommands?.findSkill(name, this.repoPathsOf(row))
        if (!skill) {
          this.logFor(workerId).userInput(text)
          this.logFor(workerId).write(`${CODEX_SLASH_LINE}\n`)
          return
        }
        // A skill the user typed runs as a skill input, with what follows the name as its text.
        skillInput = [
          { type: 'skill', name: skill.name, path: skill.path },
          {
            type: 'text',
            text: text
              .trimStart()
              .replace(/^\/\S+/, '')
              .trim()
          }
        ]
      }
    }
    const run = this.running.get(workerId)
    if (!run?.handle) {
      // Paused (no process): the first line resumes the worker with --resume, if its working copy is left.
      const reason = this.cannotLaunch(row)
      if (reason !== null) throw new AppErrorException('VALIDATION_FAILED', { reason })
      this.deps.workersRepo.setControl(workerId, 'active', this.deps.now())
      await this.relaunch(row, text, [], { control: true, leadOnFresh: true })
      this.recordInput(workerId, text)
      return
    }
    const sent =
      skillInput !== undefined && run.handle.sendInput
        ? await run.handle.sendInput(skillInput)
        : await run.handle.send(text)
    if (!sent) throw new AppErrorException('VALIDATION_FAILED')
    run.controlReplying = true
    this.recordInput(workerId, text)
  }

  /** The repositories a worker works in: where its skills are listed from. */
  private repoPathsOf(row: WorkerRow): string[] {
    const wanted = new Set(parseIds(row.projectIdsJson))
    return this.deps.sessionProjectsRepo
      .listBySession(this.deps.sessionId)
      .filter((p) => p.projectId !== null && wanted.has(p.projectId))
      .map((p) => p.projectPath)
  }

  private recordInput(workerId: string, text: string): void {
    this.deps.workersRepo.recordControlMessage(workerId, text, this.deps.now())
    this.logFor(workerId).userInput(text)
    this.pushNow(workerId)
  }

  /** `workers:interrupt`: Escape. Stops the current reply and nothing else. */
  async interruptControlled(workerId: string): Promise<{ outcome: InterruptOutcome }> {
    this.controlledRow(workerId)
    const run = this.running.get(workerId)
    if (!run?.handle) return { outcome: 'idle' }
    const outcome = await this.interruptRun(run)
    if (outcome === 'killed') {
      this.deps.workersRepo.setControl(workerId, 'paused', this.deps.now())
    }
    if (outcome !== 'idle') this.logFor(workerId).marker('Interrupted')
    this.pushNow(workerId)
    return { outcome }
  }

  /** `workers:hand-back`: the worker carries on with its task by itself. */
  async handBack(workerId: string): Promise<void> {
    const row = this.controlledRow(workerId)
    const run = this.running.get(workerId)
    // A paused worker is resumed by the hand-back text, which needs a working copy to resume in.
    if (!run?.handle) {
      const reason = this.cannotLaunch(row)
      if (reason !== null) throw new AppErrorException('VALIDATION_FAILED', { reason })
    }
    // 1. A reply that is still running is stopped first.
    let alive = run?.handle !== undefined
    if (run?.handle && run.controlReplying && (await this.interruptRun(run)) === 'killed') {
      // The process did not survive: its exit is stored as paused (control is still on), then resumed below.
      alive = false
      await run.finished
    }
    // 2. What changed since step-in, read before the bases are cleared.
    const changes = await this.changesSinceStepIn(workerId)
    const reportedDone = run?.reportedDone === true
    // 3. Control ends; from here the worker is judged like any other.
    this.clearControl(workerId)
    if (run) {
      run.controlActive = false
      run.controlReplying = false
      run.nudged = false
      if (run.helpers.size > 0 && !run.helperCapped && run.helperCapTimer === undefined) {
        this.startHelperCap(run)
      }
    }
    // 4. One user turn: carry on (and that it already reported done, if it did), then the brain's
    // held messages, oldest first. A single send, so a settled turn can never cut the messages off.
    const pending = this.deps.heldMessagesRepo.listUndelivered(workerId)
    const text = [
      reportedDone ? HAND_BACK_TEXT + HAND_BACK_REPORTED_DONE_TEXT : HAND_BACK_TEXT,
      ...pending.map((m) => heldMessageText(m.body))
    ].join('\n\n')
    let accepted = true
    if (run?.handle && alive) accepted = await run.handle.send(text)
    else {
      await this.relaunch(this.deps.workersRepo.get(workerId) ?? row, text, [], {
        leadOnFresh: true
      })
    }
    let held = 0
    if (accepted) {
      this.deps.heldMessagesRepo.markDelivered(
        pending.map((m) => m.id),
        this.deps.now()
      )
      held = pending.length
    }
    // 5. Requests still waiting return to Needs attention and take the normal path.
    this.host.routeAttentionBack(workerId)
    const label = labelOf(row)
    this.logFor(workerId).marker('You handed back')
    this.host.logEvent('user-control', `You handed ${label} back`, undefined, workerId)
    this.host.notifyBrain(
      handBackNote(label, {
        changes,
        messages: row.controlUserMessages,
        lastMessage: row.controlLastMessage,
        held
      })
    )
    this.pushNow(workerId)
    this.host.onChange()
  }

  /** The diffstat of every live working copy since the user stepped in; "repo: " prefixes only when there are several. */
  private async changesSinceStepIn(workerId: string): Promise<string[]> {
    const trees = this.deps.worktreesRepo.listControlBases(workerId)
    const projects = this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)
    const lines: string[] = []
    for (const tree of trees) {
      if (tree.controlBaseSha === null) continue
      try {
        const stat = await this.deps.worktreeGit.diffStatSince(tree.path, tree.controlBaseSha)
        const name = projects.find((p) => p.projectId === tree.projectId)?.projectName
        const prefix = trees.length > 1 && name ? `${name}: ` : ''
        lines.push(...stat.map((l) => prefix + l))
      } catch (error: unknown) {
        this.deps.log.warn(`could not read the changes of worker ${workerId} since step-in`, error)
      }
    }
    return lines
  }

  // ---- stop ----

  /** The user's Stop. Resolves when the process has exited and the worker is stored as stopped. */
  async stop(workerId: string, by: WorkerStoppedBy = 'user'): Promise<void> {
    const run = this.running.get(workerId)
    if (!run) {
      this.stopQueued(workerId, by)
      await this.stopWaitingForLimit(workerId, by)
      await this.stopPausedControlled(workerId, by)
      return
    }
    run.stopRequestedBy = by
    await run.handle?.stop()
    await run.finished
  }

  /**
   * Throws the worker's working copies away: counts the commits the session branch lacks, then
   * force-removes each copy. Used by the user's Stop and by Remove.
   */
  private async discardWorkingCopies(
    workerId: string
  ): Promise<{ removed: number; unmerged: number }> {
    const row = this.deps.workersRepo.get(workerId)
    const projects = this.deps.sessionProjectsRepo.listBySession(this.deps.sessionId)
    const trees = this.deps.worktreesRepo.listByWorker(workerId).filter((t) => t.removedAt === null)
    let unmerged = 0
    for (const tree of trees) {
      const project = projects.find((p) => p.projectId !== null && p.projectId === tree.projectId)
      if (row?.status !== 'merged' && project?.branchName) {
        unmerged += await this.deps.worktreeGit.countUnmerged(
          project.projectPath,
          project.branchName,
          tree.headSha
        )
      }
      await discardWorkingCopy(
        {
          worktreeGit: this.deps.worktreeGit,
          worktreesRepo: this.deps.worktreesRepo,
          root: this.deps.getWorktreesRoot(),
          now: this.deps.now,
          warn: (message, ...rest) => this.deps.log.warn(message, ...rest)
        },
        project?.projectPath ?? null,
        tree
      )
    }
    return { removed: trees.length, unmerged }
  }

  /**
   * `workers:remove`: hides a finished worker and throws away any working copy it still has. The row
   * stays (soft delete) so the event log and merge history keep pointing at it.
   */
  async remove(workerId: string): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (!row || row.removedAt !== null) throw new AppErrorException('VALIDATION_FAILED')
    const finished: WorkerStatus[] = ['done', 'merged', 'failed', 'stopped']
    if (!finished.includes(row.status) || this.running.has(workerId)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    // Commits the worker made since the last record count as discarded work too.
    await this.doRecordHeads(workerId)
    const { unmerged } = await this.discardWorkingCopies(workerId)
    this.deps.workersRepo.markRemoved(workerId, this.deps.now())
    this.host.logEvent(
      'worker-removed',
      `Removed ${labelOf(row)}${discardNote(unmerged)}`,
      { unmergedCommits: unmerged },
      workerId
    )
    this.host.onChange()
  }

  /**
   * A worker whose process ended while it waited for the usage limit is still "working" without a
   * process. Stopping it cancels the retry and ends it like any other stop.
   */
  private async stopWaitingForLimit(workerId: string, by: WorkerStoppedBy): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (!row || !this.host.rateLimit.isWaiting(`worker-${workerId}`)) return
    this.host.rateLimit.cancel(`worker-${workerId}`)
    if (row.status !== 'working' && row.status !== 'starting') return
    const discarded = by === 'user' ? await this.discardWorkingCopies(workerId) : null
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(workerId, 'stopped', now, by)
    this.deps.workersRepo.setActivity(workerId, null, now)
    this.host.logEvent(
      'worker-stopped',
      by === 'user'
        ? `Stopped by you${discarded?.removed ? `; working copy removed${discardNote(discarded.unmerged)}` : ''}`
        : `${labelOf(row)} stopped when Arc quit`,
      undefined,
      workerId
    )
    this.logFor(workerId).finish('Stopped')
    this.pushNow(workerId)
    this.host.onChange()
    this.drain()
  }

  /**
   * A worker the user is in control of, paused with no process (Arc was restarted). Stop ends it like
   * any other stop and ends the control with it, so a worker whose working copy is gone can still be stopped.
   */
  private async stopPausedControlled(workerId: string, by: WorkerStoppedBy): Promise<void> {
    const row = this.deps.workersRepo.get(workerId)
    if (!row || row.userControl === null || !STEPPABLE.includes(row.status)) return
    const discarded = by === 'user' ? await this.discardWorkingCopies(workerId) : null
    this.clearControl(workerId)
    const now = this.deps.now()
    this.deps.workersRepo.setStatus(workerId, 'stopped', now, by)
    this.deps.workersRepo.setActivity(workerId, null, now)
    this.host.rateLimit.cancel(`worker-${workerId}`)
    this.host.logEvent(
      'worker-stopped',
      by === 'user'
        ? `Stopped by you${discarded?.removed ? `; working copy removed${discardNote(discarded.unmerged)}` : ''}`
        : `${labelOf(row)} stopped when Arc quit`,
      undefined,
      workerId
    )
    this.logFor(workerId).finish('Stopped')
    this.pushNow(workerId)
    this.host.onChange()
    this.drain()
  }

  /** A queued worker has no process; Stop just takes it out of the queue. */
  private stopQueued(workerId: string, by: WorkerStoppedBy): void {
    const row = this.deps.workersRepo.get(workerId)
    if (row?.status !== 'queued') return
    this.deps.workersRepo.setStatus(workerId, 'stopped', this.deps.now(), by)
    this.deps.workersRepo.setActivity(workerId, null, this.deps.now())
    this.host.logEvent(
      'worker-stopped',
      by === 'user' ? 'Stopped by you' : `${labelOf(row)} stopped when Arc quit`,
      undefined,
      workerId
    )
    this.pushNow(workerId)
    this.host.onChange()
  }

  async stopAll(by: WorkerStoppedBy): Promise<void> {
    this.stopping = true
    for (const row of this.deps.workersRepo.listBySession(this.deps.sessionId)) {
      if (row.status === 'queued') this.stopQueued(row.id, by)
    }
    await Promise.all([...this.running.keys()].map((id) => this.stop(id, by)))
  }

  /** Flushes pending pushes and drops timers. */
  dispose(): void {
    this.disposed = true
    for (const state of this.pushState.values()) if (state.timer) clearTimeout(state.timer)
    this.pushState.clear()
    for (const log of this.logs.values()) log.dispose()
    this.logs.clear()
  }

  // ---- pushes (at most one per 250 ms per worker; the last state always goes out) ----

  private view(workerId: string): WorkerView | undefined {
    return this.views().find((w) => w.id === workerId)
  }

  private pushNow(workerId: string): void {
    const state = this.pushState.get(workerId)
    if (state?.timer) clearTimeout(state.timer)
    this.pushState.set(workerId, { last: this.deps.now(), timer: undefined })
    this.emit(workerId)
  }

  private schedulePush(workerId: string): void {
    if (this.disposed) return
    const state = this.pushState.get(workerId)
    if (state?.timer) return
    const since = state ? this.deps.now() - state.last : WORKER_PUSH_MS
    if (since >= WORKER_PUSH_MS) {
      this.pushNow(workerId)
      return
    }
    const timer = setTimeout(() => {
      this.pushNow(workerId)
    }, WORKER_PUSH_MS - since)
    timer.unref()
    this.pushState.set(workerId, { last: state?.last ?? 0, timer })
  }

  private emit(workerId: string): void {
    if (this.disposed) return
    const view = this.view(workerId)
    if (view) this.host.emitWorker(view)
  }
}

/** What the fallback lines call a worker: "W2", or the resolver by its role. */
function fallbackLabel(row: Pick<WorkerRow, 'number' | 'dependsOnJson'>): string {
  return isResolverRow(row) ? 'the conflict resolver' : `W${row.number}`
}
