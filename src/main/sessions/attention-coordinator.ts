import { createHash } from 'node:crypto'
import { AppErrorException } from '@shared/errors'
import { BridgeToolError } from '../bridge/types'
import type {
  BridgeAgent,
  PermissionDecision,
  RequestPermissionInput,
  ResolveRequestInput
} from '../bridge/types'
import type { AttentionRepo, AttentionRequestRow } from '../db/repositories/attention-repo'
import { allowRuleMatches, allowRuleText, deriveAllowRule } from '../policy/allow-rules'
import type { AllowRuleSpec } from '../policy/allow-rules'
import { classifyBrainAction } from '../policy/brain-policy'
import {
  classifyAction,
  isPublishAction,
  isPublishMcpTool,
  unclassified,
  writesToAttachments
} from '../policy/classify'
import type { Classification, ClassifyContext } from '../policy/classify'
import {
  CODEX_PERMISSIONS_TOOL,
  normalizeClaudeCall,
  toStoredCall
} from '../policy/normalized-action'
import type { ActionDecision, ActionMeta, NormalizedAction } from '../policy/normalized-action'
import type { AttentionRecordPrompt } from '@shared/types/session'
import type { SessionAllowRuleRow } from '../db/repositories/allow-rules-repo'
import { requestRecord } from './attention-record'
import {
  ASK_USER_QUESTION_TOOL,
  DECLINED_MESSAGE,
  HELPER_REASON,
  choicesInput,
  describeAnswers,
  parseQuestions,
  questionsOfRow
} from './attention-questions'

/** A request addressed to the brain is passed to the user after this long without action. */
export const BRAIN_ANSWER_TIMEOUT_MS = 60_000

/** A worker's `ask_brain` is remembered this long: a re-call of the same question gets the same answer. */
export const ASK_BRAIN_MEMO_MS = 10 * 60_000

const ACTION_MAX = 2000
const NOTE_COMMAND_MAX = 200

/**
 * The abort reason that means "the agent withdrew this request" (Codex dropped it because the turn
 * was interrupted). The row becomes `cancelled`. Any other abort (quit, crash, timeout) leaves the
 * row pending, and a later answer is stored undelivered.
 */
export const ACTION_WITHDRAWN = 'withdrawn'

/**
 * How a provider's approval handler (Codex, Cursor) reaches the coordinator: the worker's
 * `requestAction`, or the brain's.
 */
export type RequestAction = (
  agent: BridgeAgent,
  action: NormalizedAction,
  meta: ActionMeta,
  call: { signal: AbortSignal }
) => Promise<ActionDecision>

/** What the user's answer is: approve or deny a permission, or text for a question. */
export type AttentionAnswer =
  | { approve: boolean; always?: boolean }
  | { text: string }
  /** A structured question: per question text, the chosen labels or one typed string. */
  | { answers: Record<string, string[]> }
  /** The user dismissed a command's question. */
  | { decline: true }

/** The pending requests that are waiting for the user, for the attention service and the badge. */
export interface AttentionState {
  count: number
  requests: AttentionRequestRow[]
}

/** The worker a bridge call came from. */
export interface WorkerRef {
  id: string
  number: number
  slug: string
}

export type AttentionWorkerStatus = 'needs_approval' | 'has_question' | 'working'

export interface AttentionHost {
  sessionId: string
  now: () => number
  newId: () => string
  logEvent: (kind: string, text: string, data?: unknown, workerId?: string | null) => void
  /** The app log, for failures that are not session events (a classifier that threw). */
  log?: { warn: (message: string, ...rest: unknown[]) => void }
  /** A user-turn message to the brain (not shown in the conversation). */
  notifyBrain: (text: string) => void
  /** The worker a bridge call came from; throws when it is not running. */
  workerOf: (agent: BridgeAgent) => WorkerRef
  /** True when the tool call was made by one of the worker's background helpers. */
  isHelperToolUse?: (workerId: string, toolUseId: string) => boolean
  /** "W1 api-retry" for a stored worker id. */
  workerLabel: (workerId: string) => string
  /**
   * Where the worker may write and what it may only read, for the classifier. `null` is the brain:
   * no working copies, its own working directory, and only the temp folder to write in.
   */
  policyContext: (workerId: string | null) => ClassifyContext
  /** The worker waits on a request (`needs_approval`, `has_question`) or is back at work. */
  setWorkerStatus: (workerId: string, status: AttentionWorkerStatus) => void
  /** The brain is blocked on `ask_user`. */
  onBrainWaiting: (waiting: boolean) => void
  /** The set of requests waiting for the user changed. */
  onChanged: () => void
  /** True while the user is in control of the worker (stepped in, or paused): its requests go to its terminal. */
  isControlled: (workerId: string) => boolean
  /** The session's Auto-approve toggle. */
  autoApprove: () => boolean
  /** The session's Skip all approvals toggle, read from the session row on every call. */
  skipApprovals: () => boolean
  /**
   * Turns a Claude `mcp__<server>__<tool>` call into an `mcp` action with its read-only verdict (the
   * running agent's own list of servers decides). Null when the tool is not an MCP tool Arc decides on.
   */
  mcpAction?: (
    agent: BridgeAgent,
    tool: string,
    input: Record<string, unknown>
  ) => Promise<NormalizedAction | null>
  /** A one-line record of an answer the user gave in the request's panel, kept in the conversation. */
  recordAnswer?: (prompt: AttentionRecordPrompt) => void
  /** The session's "Always allow this in this session" rules. */
  allowRules: () => SessionAllowRuleRow[]
  /** Stores a rule and tells the renderer (the header lists the rules). */
  addAllowRule: (rule: AllowRuleSpec & { text: string }) => SessionAllowRuleRow
}

/** Why a protected request needs no one: a rule of the user's, or the Auto-approve toggle. */
type Coverage = { by: 'rule'; text: string } | { by: 'auto' } | { by: 'skip' }

/** One blocked call waiting on a request. */
interface Listener {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** The calls blocked on one request: usually one, several when a re-called `ask_brain` joined the first. */
interface Waiter {
  listeners: Set<Listener>
  /** Builds the tool result from the stored row once it is resolved. */
  result: (row: AttentionRequestRow) => unknown
}

function parseInput(json: string | null): Record<string, unknown> {
  if (json === null) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** What the user reads as "the exact action" for a tool call. */
export function describeAction(toolName: string, input: Record<string, unknown>): string {
  const command = input['command']
  if (toolName === 'Bash' && typeof command === 'string') return command
  if (toolName === CODEX_PERMISSIONS_TOOL) {
    const reason = input['reason']
    return `Extra access${typeof reason === 'string' && reason !== '' ? `: ${reason}` : ''}`
  }
  const paths = input['paths']
  if (Array.isArray(paths) && paths.every((p) => typeof p === 'string') && paths.length > 0) {
    return `${toolName} ${paths.join(', ')}`
  }
  const path = input['file_path'] ?? input['notebook_path']
  if (typeof path === 'string') return `${toolName} ${path}`
  const raw = JSON.stringify(input) ?? ''
  return `${toolName} ${raw.length > 300 ? raw.slice(0, 300) + '...' : raw}`
}

function cancelledCall(): BridgeToolError {
  return new BridgeToolError('cancelled', 'The call was cancelled before the request was answered.')
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 3) + '...' : text
}

/**
 * Permission requests and questions of one session (tech spec 2.4, 2.6 and functional spec 2.7).
 * Every request is stored first; a worker's call then waits on a promise keyed by the request id.
 * The brain decides what it may; policy-listed requests go straight to the user, and so does
 * anything the brain does not act on in 60 s. A call that dies leaves its row pending, and a later
 * answer is stored undelivered (resume in a later slice delivers it).
 */
export class AttentionCoordinator {
  private readonly waiters = new Map<string, Waiter>()
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** `ask_brain` per worker and question: the request it created, for `ASK_BRAIN_MEMO_MS`. */
  private readonly askMemo = new Map<string, { requestId: string; at: number }>()
  private brainWaits = 0
  private closed = false

  constructor(
    private readonly repo: AttentionRepo,
    private readonly host: AttentionHost,
    private readonly timeouts: { brainAnswerMs: number } = {
      brainAnswerMs: BRAIN_ANSWER_TIMEOUT_MS
    }
  ) {}

  // ---- state ----

  /**
   * Pending requests that are with the user. `requests` carries the ones answered in a worker's
   * terminal too (each has its `route`); `count`, the badge, is the Needs-attention queue only.
   */
  state(): AttentionState {
    const requests = this.repo.listPendingEscalated(this.host.sessionId)
    return { count: requests.filter((r) => r.route === 'queue').length, requests }
  }

  /**
   * Answers stored while the agent's call was gone (`delivered = false`). A resumed worker gets them
   * as a user turn (`answerNote`); a brain question answered after its call died is delivered at once.
   */
  undelivered(workerId?: string): AttentionRequestRow[] {
    return this.repo.listUndelivered(this.host.sessionId, workerId)
  }

  /** The answers reached the agent (as a user turn after a resume). */
  markDelivered(ids: readonly string[]): void {
    for (const id of ids) this.repo.markDelivered(id)
  }

  // ---- worker calls ----

  /** Claude's `request_permission` call: normalized, decided by `requestAction`, answered in the CLI's shape. */
  requestPermission(
    agent: BridgeAgent,
    input: RequestPermissionInput,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    const worker = this.host.workerOf(agent)
    // A command's question to the user (tech spec 2.6): decided before classification and coverage,
    // so Auto-approve and the allow rules never apply and the brain cannot answer it.
    if (input.tool_name === ASK_USER_QUESTION_TOOL)
      return this.requestQuestion(worker, input, signal)
    const meta: ActionMeta = {
      toolUseId: input.tool_use_id,
      stored: { toolName: input.tool_name, input: input.input }
    }
    const decide = (action: NormalizedAction): Promise<PermissionDecision> =>
      this.requestAction(agent, action, meta, signal).then((decision) =>
        permissionDecision(decision, input.input)
      )
    // Only an MCP tool waits for the agent's list of servers; every other call is classified at once.
    if (this.host.mcpAction !== undefined && input.tool_name.startsWith('mcp__')) {
      return this.host
        .mcpAction(agent, input.tool_name, input.input)
        .catch(() => null)
        .then((action) => {
          // The call died while the agent listed its servers: nothing was stored yet.
          if (signal.aborted) throw cancelledCall()
          return decide(action ?? normalizeClaudeCall(input.tool_name, input.input))
        })
    }
    return decide(normalizeClaudeCall(input.tool_name, input.input))
  }

  /**
   * One worker action, from either provider. Classified, then allowed at once when nothing
   * protects it or a rule or Auto-approve covers it; otherwise stored as a request that the brain
   * (where it may) and then the user decide. Resolves when someone does.
   */
  requestAction(
    agent: BridgeAgent,
    action: NormalizedAction,
    meta: ActionMeta,
    signal: AbortSignal
  ): Promise<ActionDecision> {
    const worker = this.host.workerOf(agent)
    const stored = meta.stored ?? toStoredCall(action)
    const classified = classifyAction(action, this.host.policyContext(worker.id))
    // Functional spec 2.5: after approval workers run commands freely. Only the policy
    // categories need anyone; everything else is allowed at once, with no row and no brain turn.
    if (classified.category === null) return Promise.resolve({ allow: true })
    const verdict = this.escalatePublishMcp(classified, stored.toolName)
    const fromHelper =
      meta.toolUseId !== undefined &&
      (this.host.isHelperToolUse?.(worker.id, meta.toolUseId) ?? false)
    const text = (fromHelper ? '(helper) ' : '') + describeAction(stored.toolName, stored.input)
    // Functional spec 2.7: a rule of the user's, or Auto-approve, settles it without a row.
    const inTerminal = this.host.isControlled(worker.id)
    const covered = this.coverage(stored.toolName, stored.input, verdict, {
      controlled: inTerminal,
      workerId: worker.id
    })
    if (covered) {
      this.logCovered(covered, text, worker.id)
      return Promise.resolve({ allow: true })
    }
    // While the user is in control the request goes to the worker's terminal: passed to the user at
    // once, with no brain turn and no brain timer.
    const row = this.repo.create({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      workerId: worker.id,
      source: 'worker',
      kind: 'permission',
      action: clip(text, ACTION_MAX),
      reason: verdict.reason,
      question: null,
      toolName: stored.toolName,
      toolInputJson: JSON.stringify(stored.input),
      toolUseId: meta.toolUseId ?? null,
      category: verdict.category,
      mustEscalate: verdict.mustEscalate,
      escalated: verdict.mustEscalate || inTerminal,
      brainNote: verdict.mustEscalate ? verdict.reason : null,
      status: 'pending',
      answer: null,
      delivered: false,
      route: inTerminal ? 'terminal' : 'queue',
      createdAt: this.host.now(),
      resolvedAt: null
    })
    const label = this.host.workerLabel(worker.id)
    const shown = clip(text, NOTE_COMMAND_MAX)
    this.host.logEvent(
      'attention',
      verdict.mustEscalate || inTerminal
        ? `${label} needs your approval: ${shown}`
        : `${label} asked permission: ${shown}`,
      { requestId: row.id, category: verdict.category },
      worker.id
    )
    this.host.setWorkerStatus(worker.id, 'needs_approval')
    if (inTerminal) {
      this.host.onChanged()
    } else {
      this.tellBrainOfPermission(row, label, shown, verdict.reason)
    }
    return this.wait<ActionDecision>(row, signal, (done) => actionResult(done))
  }

  /** An `AskUserQuestion` call: a question row for the user with the structured `questions[]` kept. */
  private requestQuestion(
    worker: WorkerRef,
    input: RequestPermissionInput,
    signal: AbortSignal
  ): Promise<PermissionDecision> {
    const questions = parseQuestions(input.input)
    if (questions === null) {
      return Promise.resolve({ behavior: 'deny', message: 'The question could not be read.' })
    }
    const fromHelper =
      input.tool_use_id !== undefined &&
      (this.host.isHelperToolUse?.(worker.id, input.tool_use_id) ?? false)
    const text = questions.map((q) => q.question).join(' / ')
    const inTerminal = this.host.isControlled(worker.id)
    const row = this.repo.create({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      workerId: worker.id,
      source: 'worker',
      kind: 'question',
      action: null,
      reason: fromHelper ? HELPER_REASON : null,
      question: clip(text, ACTION_MAX),
      toolName: ASK_USER_QUESTION_TOOL,
      toolInputJson: JSON.stringify(input.input),
      toolUseId: input.tool_use_id ?? null,
      category: null,
      // Only the user can answer: the brain's resolve_request refuses it.
      mustEscalate: true,
      escalated: true,
      brainNote: null,
      status: 'pending',
      answer: null,
      delivered: false,
      route: inTerminal ? 'terminal' : 'queue',
      createdAt: this.host.now(),
      resolvedAt: null
    })
    const label = this.host.workerLabel(worker.id) + (fromHelper ? ' (helper)' : '')
    this.host.logEvent(
      'attention',
      `${label} asks you: ${clip(text, NOTE_COMMAND_MAX)}`,
      { requestId: row.id },
      worker.id
    )
    this.host.setWorkerStatus(worker.id, 'has_question')
    if (!inTerminal) this.tellBrainOfUserQuestion(label)
    this.host.onChanged()
    return this.wait<PermissionDecision>(row, signal, (stored) => questionResult(stored))
  }

  askBrain(
    agent: BridgeAgent,
    input: { question: string },
    signal: AbortSignal
  ): Promise<{ answer: string }> {
    const worker = this.host.workerOf(agent)
    // Idempotent per worker and question (a Codex call that timed out is made again): the same
    // question while it is pending joins it, and once answered returns the same answer.
    const key = `${worker.id}:${createHash('sha256').update(input.question).digest('hex')}`
    const result = (stored: AttentionRequestRow): { answer: string } => ({
      answer: stored.answer ?? ''
    })
    const prior = this.priorAsk(key)
    if (prior?.status === 'answered') {
      this.repo.markDelivered(prior.id)
      return Promise.resolve(result(prior))
    }
    if (prior?.status === 'pending') return this.wait<{ answer: string }>(prior, signal, result)
    // While the user is in control the question goes to them in the terminal, not to the brain; the
    // user's answer is the tool result.
    const inTerminal = this.host.isControlled(worker.id)
    const row = this.repo.create({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      workerId: worker.id,
      source: 'worker',
      kind: 'question',
      action: null,
      reason: null,
      question: input.question,
      toolName: null,
      toolInputJson: null,
      toolUseId: null,
      category: null,
      mustEscalate: false,
      escalated: inTerminal,
      brainNote: null,
      status: 'pending',
      answer: null,
      delivered: false,
      route: inTerminal ? 'terminal' : 'queue',
      createdAt: this.host.now(),
      resolvedAt: null
    })
    const label = this.host.workerLabel(worker.id)
    this.host.logEvent(
      'attention',
      `${label} asked: ${clip(input.question, NOTE_COMMAND_MAX)}`,
      { requestId: row.id },
      worker.id
    )
    this.host.setWorkerStatus(worker.id, 'has_question')
    if (inTerminal) this.host.onChanged()
    else this.tellBrainOfQuestion(row, label)
    this.askMemo.set(key, { requestId: row.id, at: this.host.now() })
    return this.wait<{ answer: string }>(row, signal, result)
  }

  /** The request an earlier `ask_brain` with this key created, while the memo is fresh; expired entries are dropped. */
  private priorAsk(key: string): AttentionRequestRow | undefined {
    const now = this.host.now()
    for (const [k, memo] of this.askMemo) {
      if (now - memo.at > ASK_BRAIN_MEMO_MS) this.askMemo.delete(k)
    }
    const memo = this.askMemo.get(key)
    return memo === undefined ? undefined : this.repo.get(memo.requestId)
  }

  // ---- brain calls ----

  /**
   * The brain's shell command (`--permission-prompt-tool`). The brain reads freely: a read-only
   * command is allowed with no row. Anything that changes files or git state in the user's
   * checkouts, and the worker policy categories, go to the user at once; the brain cannot resolve
   * its own request and waits as in `ask_user`. Only Bash is available to the brain.
   */
  brainRequestPermission(
    input: RequestPermissionInput,
    signal: AbortSignal,
    agent?: BridgeAgent
  ): Promise<PermissionDecision> {
    const meta: ActionMeta = {
      toolUseId: input.tool_use_id,
      stored: { toolName: input.tool_name, input: input.input }
    }
    const decide = (action: NormalizedAction): Promise<PermissionDecision> =>
      this.brainRequestAction(action, meta, signal).then((decision) =>
        permissionDecision(decision, input.input)
      )
    if (agent && this.host.mcpAction !== undefined && input.tool_name.startsWith('mcp__')) {
      return this.host
        .mcpAction(agent, input.tool_name, input.input)
        .catch(() => null)
        .then((action) => {
          // The call died while the agent listed its servers: nothing was stored yet.
          if (signal.aborted) throw cancelledCall()
          return decide(action ?? normalizeClaudeCall(input.tool_name, input.input))
        })
    }
    return decide(normalizeClaudeCall(input.tool_name, input.input))
  }

  /** The brain's action, from either provider; see `brainRequestPermission`. */
  brainRequestAction(
    action: NormalizedAction,
    meta: ActionMeta,
    signal: AbortSignal
  ): Promise<ActionDecision> {
    const brain = classifyBrainAction(action, this.host.policyContext(null))
    if (brain.refuse !== undefined) {
      return Promise.resolve({ allow: false, message: brain.refuse })
    }
    const verdict = brain.classification
    if (verdict.category === null) return Promise.resolve({ allow: true })
    const stored = meta.stored ?? toStoredCall(action)
    const text = describeAction(stored.toolName, stored.input)
    const covered = this.coverage(stored.toolName, stored.input, verdict, {
      controlled: false,
      workerId: null
    })
    if (covered) {
      this.logCovered(covered, text, null)
      return Promise.resolve({ allow: true })
    }
    const row = this.repo.create({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      workerId: null,
      source: 'brain',
      kind: 'permission',
      action: clip(text, ACTION_MAX),
      reason: verdict.reason,
      question: null,
      toolName: stored.toolName,
      toolInputJson: JSON.stringify(stored.input),
      toolUseId: meta.toolUseId ?? null,
      category: verdict.category,
      mustEscalate: true,
      escalated: true,
      brainNote: null,
      status: 'pending',
      answer: null,
      delivered: false,
      createdAt: this.host.now(),
      resolvedAt: null
    })
    this.host.logEvent(
      'attention',
      `The brain needs your approval: ${clip(text, NOTE_COMMAND_MAX)}`,
      { requestId: row.id, category: verdict.category }
    )
    this.host.onChanged()
    const done = this.beginBrainWait()
    return this.wait<ActionDecision>(row, signal, (stored) => actionResult(stored), done)
  }

  /** The brain is blocked on the user; `onBrainWaiting(false)` fires when the last wait ends. */
  private beginBrainWait(): () => void {
    this.brainWaits += 1
    if (this.brainWaits === 1) this.host.onBrainWaiting(true)
    return () => {
      this.brainWaits = Math.max(0, this.brainWaits - 1)
      if (this.brainWaits === 0) this.host.onBrainWaiting(false)
    }
  }

  /** The brain asks the user. It goes to the user at once, and the brain waits as in `propose_plan`. */
  askUser(
    input: { question: string; choices?: string[] },
    signal: AbortSignal
  ): Promise<{ answer: string }> {
    const row = this.repo.create({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      workerId: null,
      source: 'brain',
      kind: 'question',
      action: null,
      reason: null,
      question: input.question,
      toolName: null,
      // With choices the row carries one structured single-select question (buttons plus a typed box).
      toolInputJson: input.choices
        ? JSON.stringify(choicesInput(input.question, input.choices))
        : null,
      toolUseId: null,
      category: null,
      mustEscalate: false,
      escalated: true,
      brainNote: null,
      status: 'pending',
      answer: null,
      delivered: false,
      createdAt: this.host.now(),
      resolvedAt: null
    })
    this.host.logEvent(
      'attention',
      `The brain asks you: ${clip(input.question, NOTE_COMMAND_MAX)}`,
      { requestId: row.id }
    )
    this.host.onChanged()
    const done = this.beginBrainWait()
    return this.wait<{ answer: string }>(
      row,
      signal,
      (stored) => ({ answer: stored.answer ?? '' }),
      done
    )
  }

  /** The brain decides a worker's request. Never a request that is already with the user. */
  resolveRequest(agent: BridgeAgent, input: ResolveRequestInput): { ok: true } {
    const row = this.ownRequest(agent, input.requestId)
    if (row.route === 'terminal') {
      throw new BridgeToolError(
        'not_resolvable',
        "The user is answering this in the worker's terminal."
      )
    }
    if (row.source !== 'worker') {
      throw new BridgeToolError('not_resolvable', 'Only the user can answer this request.')
    }
    if (row.toolName === ASK_USER_QUESTION_TOOL) {
      throw new BridgeToolError(
        'not_resolvable',
        'This is a question the worker asked the user. Only the user can answer it; Arc already passed it on.'
      )
    }
    if (row.mustEscalate) {
      throw new BridgeToolError(
        'policy_requires_user',
        'This request must go to the user: it leaves the machine, is destructive, installs software for the whole machine or changes files outside the working copy. Call escalate_to_user or leave it; Arc already passed it on.'
      )
    }
    if (row.escalated) {
      throw new BridgeToolError('already_escalated', 'This request is already with the user.')
    }
    const note = input.note?.trim() ?? ''
    // "W2", as in "W2 question answered by brain".
    const worker = this.workerLabel(row).split(' ')[0] ?? 'A worker'

    if (row.kind === 'permission') {
      if (input.decision === 'answer') {
        throw new BridgeToolError(
          'wrong_decision',
          'This is a permission request: use decision "approve" or "deny".'
        )
      }
      const approved = input.decision === 'approve'
      this.settle(
        row,
        approved ? 'approved' : 'denied',
        approved ? null : `The brain denied this request.${note === '' ? '' : ` ${note}`}`
      )
      this.host.logEvent(
        'attention',
        `${worker} request ${approved ? 'approved' : 'denied'} by brain`,
        { requestId: row.id, note },
        row.workerId
      )
      return { ok: true }
    }
    if (input.decision !== 'answer' || (input.answer ?? '').trim() === '') {
      throw new BridgeToolError(
        'wrong_decision',
        'This is a question: use decision "answer" and give the answer.'
      )
    }
    this.settle(row, 'answered', (input.answer ?? '').trim())
    this.host.logEvent(
      'attention',
      `${worker} question answered by brain`,
      { requestId: row.id, note },
      row.workerId
    )
    return { ok: true }
  }

  /** The brain passes a request on to the user. */
  escalateToUser(agent: BridgeAgent, input: { requestId: string; reason: string }): { ok: true } {
    const row = this.ownRequest(agent, input.requestId)
    if (row.source !== 'worker') {
      throw new BridgeToolError('not_resolvable', 'This request is already with the user.')
    }
    if (row.escalated) return { ok: true }
    this.escalate(row, input.reason.trim(), `Passed to you: ${input.reason.trim()}`)
    return { ok: true }
  }

  // ---- the user ----

  /**
   * The user's answer (`attention:answer`). Resolves the row, settles the blocked call (or stores
   * the answer undelivered when the call is gone), logs it and puts the worker back to work.
   */
  answer(requestId: string, answer: AttentionAnswer): void {
    const row = this.repo.get(requestId)
    if (row?.sessionId !== this.host.sessionId || row.status !== 'pending') {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    if ('decline' in answer) {
      if (row.toolName !== ASK_USER_QUESTION_TOOL) throw new AppErrorException('VALIDATION_FAILED')
      this.settle(row, 'denied', DECLINED_MESSAGE)
      this.host.logEvent(
        'attention',
        'Declined by you',
        { requestId: row.id, worker: this.workerLabel(row) },
        row.workerId
      )
      this.record(row, 'declined')
      return
    }
    if ('answers' in answer) {
      const chosen = this.chosenAnswers(row, answer.answers)
      const summary = describeAnswers(chosen)
      if (row.toolName === ASK_USER_QUESTION_TOOL) {
        this.settle(row, 'answered', JSON.stringify(chosen))
      } else {
        // The brain's ask_user with choices: one question, and the answer is the label or typed text.
        this.settle(row, 'answered', Object.values(chosen)[0] ?? '')
      }
      this.host.logEvent(
        'attention',
        `Answered by you: ${clip(summary, NOTE_COMMAND_MAX)}`,
        { requestId: row.id },
        row.workerId
      )
      this.record(row, 'answered', Object.values(chosen).join('; '))
      return
    }
    if ('text' in answer) {
      if (
        row.kind !== 'question' ||
        row.toolName === ASK_USER_QUESTION_TOOL ||
        answer.text.trim() === ''
      ) {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      const text = answer.text.trim()
      this.settle(row, 'answered', text)
      this.host.logEvent(
        'attention',
        `Answered by you: ${clip(text, NOTE_COMMAND_MAX)}`,
        { requestId: row.id },
        row.workerId
      )
      this.record(row, 'answered', text)
      return
    }
    if (row.kind !== 'permission') throw new AppErrorException('VALIDATION_FAILED')
    if (answer.always === true && !answer.approve) throw new AppErrorException('VALIDATION_FAILED')
    // The rule is derived before the answer settles, while the request still stands.
    const rule = answer.always === true ? this.ruleFor(row) : null
    this.settle(
      row,
      answer.approve ? 'approved' : 'denied',
      answer.approve ? null : 'The user denied this request.'
    )
    this.host.logEvent(
      'attention',
      answer.approve ? 'Approved by you' : 'Denied by you',
      { requestId: row.id, worker: this.workerLabel(row) },
      row.workerId
    )
    this.record(row, answer.approve ? (rule ? 'always' : 'approved') : 'denied')
    if (rule) {
      const stored = this.host.addAllowRule(rule)
      this.host.logEvent('allow-rule', `Always allowed in this session: ${stored.text}`, {
        ruleId: stored.id
      })
      this.resolveCovered()
    }
  }

  /**
   * Keeps the user's answer in the conversation. Only a request answered in the panel (the queue
   * route) gets a record; the requests an "always" answer clears afterwards get none.
   */
  private record(
    row: AttentionRequestRow,
    decision: AttentionRecordPrompt['decision'],
    answer?: string
  ): void {
    if (row.route !== 'queue' || this.host.recordAnswer === undefined) return
    const label = row.workerId === null ? 'A worker' : this.host.workerLabel(row.workerId)
    this.host.recordAnswer(requestRecord(row, label, decision, answer))
  }

  /**
   * The user's structured answers checked against the stored questions: one entry per question, no
   * other keys, a single choice or typed text for a single-select, any number of labels for a
   * multi-select. Returns each question's answer as the CLI expects it (labels joined with ", ").
   */
  private chosenAnswers(
    row: AttentionRequestRow,
    answers: Record<string, string[]>
  ): Record<string, string> {
    const questions = questionsOfRow(row)
    if (!questions) throw new AppErrorException('VALIDATION_FAILED')
    const keys = Object.keys(answers)
    if (
      keys.length !== questions.length ||
      keys.some((k) => !questions.some((q) => q.question === k))
    ) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const chosen: Record<string, string> = {}
    for (const q of questions) {
      const values = (answers[q.question] ?? []).map((v) => v.trim()).filter((v) => v !== '')
      if (values.length === 0 || (!q.multiSelect && values.length > 1)) {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      chosen[q.question] = values.join(', ')
    }
    return chosen
  }

  /**
   * The Auto-approve or Skip all approvals toggle or the rules changed: approve every pending
   * permission request they now cover. Under skip a push or a pull or merge request is never covered.
   */
  resolveCovered(): void {
    for (const row of this.repo.listPending(this.host.sessionId)) {
      if (row.kind !== 'permission' || row.toolName === null) continue
      const input = parseInput(row.toolInputJson)
      let verdict: Classification
      try {
        verdict = this.verdictFor(row, input)
      } catch (error: unknown) {
        this.host.log?.warn(`attention: could not classify ${row.toolName}`, error)
        continue
      }
      if (verdict.category === null) continue
      // A request waiting in the worker's terminal stays there while Skip all approvals is on.
      const covered = this.coverage(row.toolName, input, verdict, {
        controlled: row.route === 'terminal',
        workerId: row.workerId
      })
      if (!covered) continue
      this.settle(row, 'approved', null)
      this.logCovered(covered, row.action ?? row.toolName, row.workerId)
    }
  }

  /**
   * Step-in: the worker's pending requests move to its terminal. Each counts as passed to the user and
   * loses its brain timer; the blocked tool call stays blocked until the user answers.
   */
  routeToTerminal(workerId: string): void {
    const moved = this.repo.rerouteToTerminal(workerId)
    if (moved.length === 0) return
    for (const row of moved) this.clearTimer(row.id)
    this.host.onChanged()
  }

  /**
   * Hand-back: the worker's pending terminal requests return to Needs attention and take the normal
   * path again: the brain first for the ones it may decide, the user for the ones it may not.
   */
  routeBack(workerId: string): void {
    const movedAll = this.repo.routeBack(workerId)
    if (movedAll.length === 0) return
    // Under Skip all approvals the requests that waited in the terminal are approved now, and the
    // brain is told only of the ones that stay.
    if (this.host.skipApprovals()) this.resolveCovered()
    const moved = this.host.skipApprovals()
      ? movedAll.filter((row) => this.repo.get(row.id)?.status === 'pending')
      : movedAll
    const label = this.host.workerLabel(workerId)
    for (const row of moved) {
      if (row.kind === 'permission') {
        const shown = clip(row.action ?? row.toolName ?? 'a protected action', NOTE_COMMAND_MAX)
        this.tellBrainOfPermission(row, label, shown, row.reason ?? '')
      } else if (row.toolName === ASK_USER_QUESTION_TOOL) {
        this.tellBrainOfUserQuestion(label)
      } else {
        this.tellBrainOfQuestion(row, label)
      }
    }
    this.host.onChanged()
  }

  /**
   * The user stopped the worker, or removed it: its waiting requests are over and leave the list
   * (both routes). They are cancelled and counted as delivered, so no answer is ever carried to the
   * worker; a blocked call still waiting on one is released as a withdrawn request is. No record is
   * written and the brain is told nothing. Not for a quit or a crash: those keep the requests for
   * the resumed worker. Nothing pending for the worker is a no-op.
   */
  cancelForWorker(workerId: string): void {
    const rows = this.repo.listPending(this.host.sessionId).filter((r) => r.workerId === workerId)
    let changed = false
    for (const row of rows) {
      this.clearTimer(row.id)
      if (!this.repo.resolve(row.id, 'cancelled', null, this.host.now())) continue
      this.repo.markDelivered(row.id)
      changed = true
      const waiter = this.waiters.get(row.id)
      this.waiters.delete(row.id)
      for (const listener of waiter?.listeners ?? []) {
        listener.reject(
          new BridgeToolError(
            'cancelled',
            'The call was cancelled before the request was answered.'
          )
        )
      }
    }
    if (!changed) return
    this.refreshWorker(workerId)
    this.host.onChanged()
  }

  /** Settles every waiting call (shutdown) and stops the timers; the rows stay pending. */
  releaseAll(): void {
    this.closed = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    for (const waiter of this.waiters.values()) {
      for (const listener of waiter.listeners) {
        listener.reject(new BridgeToolError('shutting_down', 'Arc is shutting down.'))
      }
    }
    this.waiters.clear()
  }

  // ---- internals ----

  /** The user's rule, or Auto-approve (never for a push or a merge/pull request), that covers a protected request. */
  private coverage(
    tool: string,
    input: Record<string, unknown>,
    verdict: Classification,
    ctx: { controlled: boolean; workerId: string | null }
  ): Coverage | null {
    const rule = this.host
      .allowRules()
      .find((r) =>
        allowRuleMatches(
          { category: r.category, tool: r.tool, prefix: r.prefix, folder: r.folder },
          tool,
          input,
          verdict
        )
      )
    if (rule) return { by: 'rule', text: rule.text }
    // Skip all approvals replaces Auto-approve while on: every permission is approved except a push
    // or a pull or merge request, which keep going to the user.
    if (this.host.skipApprovals()) return this.skipCoverage(tool, input, ctx)
    if (this.host.autoApprove() && !isPublishAction(tool, input)) return { by: 'auto' }
    return null
  }

  /**
   * What Skip all approvals covers: everything but a worker the user is in control of (it asks in its
   * terminal), a push or a pull or merge request (a command or an MCP tool) and a change to the
   * session's attachments, which stay read-only.
   */
  private skipCoverage(
    tool: string,
    input: Record<string, unknown>,
    ctx: { controlled: boolean; workerId: string | null }
  ): Coverage | null {
    if (ctx.controlled) return null
    if (isPublishAction(tool, input) || isPublishMcpTool(tool)) return null
    if (
      writesToAttachments(normalizeClaudeCall(tool, input), this.host.policyContext(ctx.workerId))
    ) {
      return null
    }
    return { by: 'skip' }
  }

  /** While Skip all approvals is on, a publishing MCP tool goes straight to the user, not to the brain. */
  private escalatePublishMcp(verdict: Classification, toolName: string): Classification {
    return this.host.skipApprovals() &&
      verdict.category === 'mcp_write' &&
      isPublishMcpTool(toolName)
      ? { ...verdict, mustEscalate: true }
      : verdict
  }

  private logCovered(covered: Coverage, action: string, workerId: string | null): void {
    const label = workerId === null ? null : this.host.workerLabel(workerId)
    const shown = clip(action, NOTE_COMMAND_MAX)
    const [kind, text] =
      covered.by === 'rule'
        ? (['allow-rule', `Allowed by your rule: ${covered.text}`] as const)
        : covered.by === 'skip'
          ? (['skip-approved', `Approved (skipping approvals): ${shown}`] as const)
          : (['auto-approved', `Auto-approved: ${shown}`] as const)
    this.host.logEvent(kind, text, label === null ? undefined : { worker: label }, workerId)
  }

  /** The rule "always allow" would store for a stored request, or null when none can be derived. */
  private ruleFor(row: AttentionRequestRow): (AllowRuleSpec & { text: string }) | null {
    if (row.toolName === null) return null
    const input = parseInput(row.toolInputJson)
    try {
      const verdict = this.verdictFor(row, input)
      const spec = deriveAllowRule(row.toolName, input, verdict)
      return spec ? { ...spec, text: allowRuleText(spec) } : null
    } catch (error: unknown) {
      this.host.log?.warn(`attention: could not derive an allow rule for ${row.toolName}`, error)
      return null
    }
  }

  /** The policy verdict for a stored request: the brain's rules for its own, the worker's for a worker's. */
  private verdictFor(row: AttentionRequestRow, input: Record<string, unknown>): Classification {
    const toolName = row.toolName ?? ''
    // An MCP tool cannot be told read-only from its stored name; the row holds the verdict it was given.
    if (toolName.startsWith('mcp__') && row.category === 'mcp_write') {
      return { category: 'mcp_write', mustEscalate: false, reason: row.reason ?? '', paths: [] }
    }
    const action = normalizeClaudeCall(toolName, input)
    if (row.source === 'brain') {
      const brain = classifyBrainAction(action, this.host.policyContext(null))
      return brain.refuse === undefined ? brain.classification : unclassified()
    }
    return classifyAction(action, this.host.policyContext(row.workerId ?? ''))
  }

  private ownRequest(agent: BridgeAgent, requestId: string): AttentionRequestRow {
    const row = this.repo.get(requestId)
    if (row?.sessionId !== agent.sessionId) {
      throw new BridgeToolError('unknown_request', `No request "${requestId}" in this session.`)
    }
    if (row.status !== 'pending') {
      throw new BridgeToolError('already_resolved', 'This request was already resolved.')
    }
    return row
  }

  private workerLabel(row: AttentionRequestRow): string {
    return row.workerId === null ? 'The brain' : this.host.workerLabel(row.workerId)
  }

  private wait<T>(
    row: AttentionRequestRow,
    signal: AbortSignal,
    result: (row: AttentionRequestRow) => unknown,
    onDone?: () => void
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const listener: Listener = {
        resolve: (value) => {
          onDone?.()
          resolve(value as T)
        },
        reject: (error) => {
          onDone?.()
          reject(error)
        }
      }
      // A second call on the same request (a re-called `ask_brain`) joins the first one's waiter.
      const waiter: Waiter = this.waiters.get(row.id) ?? { listeners: new Set(), result }
      waiter.listeners.add(listener)
      this.waiters.set(row.id, waiter)
      signal.addEventListener(
        'abort',
        () => {
          // The call died (timeout, quit, crash): the row stays pending and a later answer is
          // stored undelivered. A request the agent withdrew is over for good.
          if (this.waiters.get(row.id) !== waiter || !waiter.listeners.delete(listener)) return
          if (waiter.listeners.size === 0) {
            this.waiters.delete(row.id)
            if (signal.reason === ACTION_WITHDRAWN) this.cancelWithdrawn(row)
          }
          listener.reject(
            new BridgeToolError(
              'cancelled',
              'The call was cancelled before the request was answered.'
            )
          )
        },
        { once: true }
      )
    })
  }

  /** The agent withdrew a request nobody had answered (a Codex turn was interrupted): it is cancelled and needs no note. */
  private cancelWithdrawn(row: AttentionRequestRow): void {
    this.clearTimer(row.id)
    if (!this.repo.resolve(row.id, 'cancelled', null, this.host.now())) return
    this.repo.markDelivered(row.id)
    this.host.logEvent(
      'attention',
      `${this.workerLabel(row)} withdrew a request: ${clip(row.action ?? row.toolName ?? 'an action', NOTE_COMMAND_MAX)}`,
      { requestId: row.id },
      row.workerId
    )
    if (row.workerId !== null) this.refreshWorker(row.workerId)
    this.host.onChanged()
  }

  /** The brain's turn for a permission request: it decides, or learns that only the user can. */
  private tellBrainOfPermission(
    row: AttentionRequestRow,
    label: string,
    shown: string,
    reason: string
  ): void {
    if (row.mustEscalate) {
      this.host.notifyBrain(
        `[Arc] ${label} asks permission to run \`${shown}\` (request ${row.id}). ${reason} ` +
          `Arc passed it to the user; you cannot approve it. Carry on with other work. No reply needed; the user sees this in Needs attention.`
      )
      this.host.onChanged()
    } else {
      this.host.notifyBrain(
        `[Arc] ${label} asks permission to run \`${shown}\` (request ${row.id}). Call resolve_request or escalate_to_user.`
      )
      this.armBrainTimer(row.id)
    }
  }

  private tellBrainOfUserQuestion(label: string): void {
    this.host.notifyBrain(
      `[Arc] ${label} asks the user a question. Arc passed it to the user; you cannot answer it.`
    )
  }

  private tellBrainOfQuestion(row: AttentionRequestRow, label: string): void {
    this.host.notifyBrain(
      `[Arc] ${label} asks: "${clip(row.question ?? '', 500)}" (request ${row.id}). ` +
        `Answer with resolve_request (decision "answer") or call escalate_to_user.`
    )
    this.armBrainTimer(row.id)
  }

  private armBrainTimer(requestId: string): void {
    if (this.closed) return
    const timer = setTimeout(() => {
      this.timers.delete(requestId)
      const row = this.repo.get(requestId)
      if (row?.status !== 'pending' || row.escalated) return
      this.escalate(
        row,
        "The brain didn't answer in time.",
        "Passed to you: the brain didn't answer in time"
      )
    }, this.timeouts.brainAnswerMs)
    timer.unref()
    this.timers.set(requestId, timer)
  }

  private clearTimer(requestId: string): void {
    const timer = this.timers.get(requestId)
    if (timer) clearTimeout(timer)
    this.timers.delete(requestId)
  }

  private escalate(row: AttentionRequestRow, note: string, logText: string): void {
    this.clearTimer(row.id)
    this.repo.markEscalated(row.id, note)
    this.host.logEvent('attention', logText, { requestId: row.id }, row.workerId)
    this.host.onChanged()
  }

  /** Stores the resolution and releases the blocked call, if it is still there. */
  private settle(
    row: AttentionRequestRow,
    status: 'approved' | 'denied' | 'answered',
    answer: string | null
  ): void {
    this.clearTimer(row.id)
    const changed = this.repo.resolve(row.id, status, answer, this.host.now())
    if (!changed) return
    const stored = this.repo.get(row.id) ?? { ...row, status, answer }
    const waiter = this.waiters.get(row.id)
    this.waiters.delete(row.id)
    if (waiter) {
      this.repo.markDelivered(row.id)
      const value = waiter.result(stored)
      for (const listener of waiter.listeners) listener.resolve(value)
    } else if (row.source === 'brain' && !this.closed) {
      // The brain's call is gone (Arc restarted, or the call timed out): the answer is its next user message.
      this.host.notifyBrain(answerNote(stored))
      this.repo.markDelivered(row.id)
    }
    if (row.workerId !== null) this.refreshWorker(row.workerId)
    this.host.onChanged()
  }

  /** needs_approval while a permission waits, has_question while a question waits, otherwise working. */
  private refreshWorker(workerId: string): void {
    const pending = this.repo
      .listPending(this.host.sessionId)
      .filter((r) => r.workerId === workerId)
    if (pending.some((r) => r.kind === 'permission')) {
      this.host.setWorkerStatus(workerId, 'needs_approval')
    } else if (pending.length > 0) {
      this.host.setWorkerStatus(workerId, 'has_question')
    } else {
      this.host.setWorkerStatus(workerId, 'working')
    }
  }
}

/**
 * The user turn that carries an answer to an agent whose call died with its process. Worker
 * requests read "Your earlier request '<action>' was approved/denied: ..."; questions read
 * "Answer to your question: ...".
 */
export function answerNote(row: AttentionRequestRow): string {
  if (row.toolName === ASK_USER_QUESTION_TOOL) {
    if (row.status === 'cancelled') return QUESTION_CANCELLED_NOTE
    if (row.status === 'answered') {
      return `The user answered your question: ${describeAnswers(parseAnswers(row.answer))}.`
    }
    return 'The user declined to answer your question.'
  }
  if (row.kind === 'question') return `Answer to your question: ${row.answer ?? ''}`
  const action = clip(row.action ?? row.toolName ?? 'a protected action', NOTE_COMMAND_MAX)
  return row.status === 'approved'
    ? `Your earlier request '${action}' was approved: you may go ahead.`
    : `Your earlier request '${action}' was denied: ${row.answer ?? 'do not do it.'}`
}

/** The decision a resolved row stands for. */
function actionResult(row: AttentionRequestRow): ActionDecision {
  if (row.status === 'approved') return { allow: true }
  return { allow: false, message: row.answer ?? 'This request was denied.' }
}

/** A decision in the shape of Claude's permission prompt tool; an allow returns the input unchanged. */
function permissionDecision(
  decision: ActionDecision,
  input: Record<string, unknown>
): PermissionDecision {
  return decision.allow
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: decision.message ?? 'This request was denied.' }
}

/** What a resumed worker is told about an AskUserQuestion that was cancelled when Arc closed. */
export const QUESTION_CANCELLED_NOTE =
  'Your question was cancelled when Arc closed; ask it again if you still need the answer.'

/** The stored `{question: answer}` map of an answered AskUserQuestion row. */
function parseAnswers(json: string | null): Record<string, string> {
  const parsed = parseInput(json)
  return Object.fromEntries(
    Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string')
  )
}

/** The CLI's answer to an AskUserQuestion call: the stored answers in `updatedInput.answers`, or a deny. */
function questionResult(row: AttentionRequestRow): PermissionDecision {
  if (row.status === 'answered') {
    return {
      behavior: 'allow',
      updatedInput: { ...parseInput(row.toolInputJson), answers: parseAnswers(row.answer) }
    }
  }
  return { behavior: 'deny', message: row.answer ?? DECLINED_MESSAGE }
}
