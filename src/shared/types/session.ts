import type { TokenTotals } from './usage'
import type { ProviderId, ProviderState, ProviderStatus, RunningOn, WorkersPref } from './provider'

export type CliState = ProviderState

/** The part of a provider status the Claude banner and the session gate read. */
export type CliStatus = Pick<ProviderStatus, 'state' | 'version' | 'message'>

export type SessionMode = 'plan_first' | 'autonomous'
export type SessionStatus = 'active' | 'stopped'
export type MessageRole = 'user' | 'brain' | 'system'
export type MessageState = 'streaming' | 'complete' | 'stopped'
export type BrainState = 'idle' | 'thinking' | 'waiting'

/** Name every session has until the brain's title (or the fallback) renames it. */
export const PLACEHOLDER_SESSION_NAME = 'New session'

/**
 * The badge in the session list. Derived, never stored (see `deriveListStatus` in main):
 * stopped session -> 'stopped'; else pending attention -> 'needs-attention'; else brain thinking
 * or an active worker -> 'working'; else 'idle'.
 */
export type SessionListStatus = 'working' | 'needs-attention' | 'idle' | 'stopped'

/** One row of the session list. */
export interface SessionSummary {
  id: string
  groupId: string
  name: string
  lastActiveAt: number
  status: SessionStatus
  /** The derived list badge. */
  listStatus: SessionListStatus
  /** Pending requests that are with the user. */
  attentionCount: number
}

/** One project of a session: the session branch it is on, or read only when it is not a git repository. */
export interface SessionBranch {
  projectId: string | null
  projectName: string
  /** `arc/<slug>`; null while the branch is not created yet (before the brain named the session) and for read-only projects. */
  branchName: string | null
  baseBranch: string | null
  readOnly: boolean
  /** Present (true) when the project left the group while the session existed: shown as "Removed", no new workers. */
  removed?: true
}

/** An "Always allow this in this session" rule, listed in the header so it can be shown and removed. */
export interface AllowRuleView {
  id: string
  /** What the user reads: `git push`, `mkdir in /opt/app`. */
  text: string
  category:
    | 'outside_worktree'
    | 'leaves_machine'
    | 'destructive'
    | 'global_install'
    | 'extra_permissions'
    | 'mcp_write'
    | 'changes_checkout'
  createdAt: number
}

export interface SessionHeader {
  id: string
  groupId: string
  name: string
  mode: SessionMode
  workerLimit: number
  /** 'auto' or the pinned model id; a provider pick reads as 'auto'. `workers` is authoritative. */
  model: string
  /** The session's Workers choice. Always set by the main process. */
  workers?: WorkersPref
  /** The brain's own model: an alias or a model id. Applies from the brain's next reply. */
  brainModel: string
  /** What runs the brain: `sessions.brain_provider` with `brain_model`. Always set by the main process. */
  brainRunningOn?: RunningOn
  /** Every protected request is approved without asking, except pushes and merge/pull requests. */
  autoApprove: boolean
  /** The session's "Always allow this in this session" rules, oldest first. */
  allowRules: AllowRuleView[]
  status: SessionStatus
  createdAt: number
  lastActiveAt: number
  /** One entry per project the session started with. Updated by `session:header` when branches are created. */
  branches: SessionBranch[]
}

/**
 * A system message with buttons. `continue-workers` is posted when a session is opened and workers
 * were stopped by a quit or a crash: Continue calls `workers:continue` with `all`, Not now calls
 * `sessions:dismiss-prompt`. `status` leaves `open` once the user answered (or the workers were
 * continued some other way); the message is then pushed again with the new status.
 */
export type MessagePrompt =
  | {
      kind: 'continue-workers'
      workerIds: string[]
      status: 'open' | 'continued' | 'dismissed'
    }
  | ReviewLinkPrompt

/**
 * Marks the brain's reply to the final summary (or the "All work is merged." fallback system
 * message): the conversation shows a Review changes link after it. It has no buttons and no status.
 */
export interface ReviewLinkPrompt {
  kind: 'review-link'
}

export interface SessionMessage {
  /** Database id; also the `messageId` of `session:brain-delta`. Ascending within a session. */
  id: number
  sessionId: string
  role: MessageRole
  content: string
  state: MessageState
  planId: string | null
  /** Present only on a system message that offers buttons. */
  prompt?: MessagePrompt
  createdAt: number
  updatedAt: number
}

export interface SessionEventEntry {
  id: number
  sessionId: string
  at: number
  kind: string
  text: string
  workerId: string | null
  /** JSON payload of the entry when it has one (`renamed` carries `{ name }`). */
  dataJson?: string | null
}

export type WorkerStatus =
  | 'queued'
  | 'starting'
  | 'working'
  | 'needs_approval'
  | 'has_question'
  | 'done'
  | 'merged'
  | 'failed'
  | 'stopped'

/** The user-control overlay on a worker; mirrors `UserControl` in the DB schema (a test keeps them equal). */
export const USER_CONTROL_VALUES = ['active', 'paused'] as const
export type UserControl = (typeof USER_CONTROL_VALUES)[number]

/** Where an attention request is answered; mirrors `AttentionRoute` in the DB schema. */
export const ATTENTION_ROUTE_VALUES = ['queue', 'terminal'] as const
export type AttentionRoute = (typeof ATTENTION_ROUTE_VALUES)[number]

export type WorkerStoppedBy = 'user' | 'quit' | 'crash'

/** One working copy of a worker: a detached worktree of one project. */
export interface WorkerWorktreeView {
  projectId: string | null
  projectName: string
  path: string
  baseSha: string
  headSha: string
}

export type WorkerRole = 'worker' | 'resolver'

/** A worker as the session screen shows it. `slug` is the display name (`W<number> · <slug>`). */
export interface WorkerView {
  id: string
  sessionId: string
  number: number
  slug: string
  /** `resolver` for the short-lived agent that resolves a merge conflict; shown as "Conflict resolver". */
  role: WorkerRole
  task: string
  projectIds: string[]
  model: string
  /** What runs the worker, from its stored columns. Always set by the main process. */
  runningOn?: RunningOn
  status: WorkerStatus
  /** One short line of what it is doing now; null when unknown. */
  activity: string | null
  failureReason: string | null
  summary: string | null
  stoppedBy: WorkerStoppedBy | null
  worktrees: WorkerWorktreeView[]
  /** True while at least one working copy of the worker is still on disk. */
  hasWorkingCopy: boolean
  /**
   * Commits in the worker's working copies that the session branch does not have, as far as Arc has
   * recorded them (exact when the worker last stopped; `workers:get` reads git for the exact number).
   * 0 for a merged worker or one without a working copy. A user Stop or Remove discards them.
   */
  unmergedCommits: number
  /** Background helper agents the worker CLI runs right now. Always set by the main process; absent means 0. */
  helpersRunning?: number
  /** The user is in control of the worker (spec 006); the real `status` still applies underneath. Always set by the main process. */
  userControl?: UserControl | null
  /** A turn is running while the user is in control. Always set by the main process. */
  controlReplying?: boolean
  /** The slash command the worker runs (e.g. `/awos:spec`); absent for an ordinary task. */
  command?: string
  /**
   * Tokens this worker has used, from the recorded usage rows. Set by the main process whenever usage
   * recording is on (zeros before the first row, null for a worker created before tracking started); refreshed by `session:worker-changed` after each
   * recorded turn (within the 250 ms worker push) and by `usage:session-changed` (same figures). While a turn runs
   * it also follows each request the agent makes.
   */
  tokens?: TokenTotals | null
  /**
   * True while the worker is mid-turn and has spent tokens that are not yet a saved row; `tokens`
   * already includes them, and the card marks the number as still rising. Absent means false.
   */
  tokensInFlight?: boolean
  createdAt: number
  updatedAt: number
}

/** `workers:get`: the detail view of one worker. */
export interface WorkerDetails {
  id: string
  sessionId: string
  number: number
  role: WorkerRole
  /** Display name, `W<number> · <slug>`; `Conflict resolver` for a resolver. */
  name: string
  status: WorkerStatus
  model: string
  /** What runs the worker. Always set by the main process. */
  runningOn?: RunningOn
  task: string
  activity: string | null
  /** The worker's own closing report (`report_done`); null until it reports. */
  lastReport: string | null
  failureReason: string | null
  stoppedBy: WorkerStoppedBy | null
  /**
   * Files changed since the worker's base: committed (`git diff --name-only <base_sha>`) plus
   * uncommitted and untracked, each path once. With more than one working copy a path is prefixed
   * with `<projectName>/`.
   */
  changedFiles: string[]
  worktreePaths: { projectName: string; path: string }[]
  /** Names of the projects the worker works in. */
  projects: string[]
  /** True while at least one working copy of the worker is still on disk. */
  hasWorkingCopy: boolean
  /**
   * Exact, read from git: commits in the working copies' HEAD that are not reachable from the session
   * branch (`git rev-list --count arc/<slug>..<head>` per repository, summed). 0 for a merged worker.
   * Stop (when running) and Remove (when Done and not merged) discard them: the UI warns when > 0.
   */
  unmergedCommits: number
  /** The user is in control of the worker; always set by the main process. */
  userControl?: UserControl | null
  /** A turn is running while the user is in control; always set by the main process. */
  controlReplying?: boolean
}

export type PlanStatus = 'proposed' | 'approved' | 'replaced' | 'rejected'

/** One worker the brain proposes in a plan. */
export interface PlanWorkerView {
  name: string
  task: string
  /** Project names. */
  repos: string[]
  /** The brain's proposal; null when it proposed none. */
  model: string | null
  rationale: string
  /** The slash command this worker runs (e.g. `/awos:spec retry settings`); absent for an ordinary task. */
  command?: string
  /** The model the user chose on the plan card; set when the plan is approved. */
  approvedModel?: string
  /** The provider the proposed `model` belongs to; legacy plans lack it and read as `claude`. */
  provider?: ProviderId
  /** The provider of `approvedModel`; read as `provider` when absent. */
  approvedProvider?: ProviderId
  /** What the worker will run on: the approved choice, else the proposal, else the default. Set by `planView`, never stored. */
  runningOn?: RunningOn
}

export interface PlanView {
  id: string
  sessionId: string
  status: PlanStatus
  workers: PlanWorkerView[]
  /** The brain message that carries the plan card. */
  messageId: number | null
  replacedById: string | null
  /**
   * True after "Ask for changes" while the plan is still `proposed`: the user's next message goes to the
   * brain as the comment, and the plan becomes `replaced` when the brain proposes a new one.
   */
  changesRequested: boolean
  createdAt: number
  resolvedAt: number | null
}

/** One question of a structured request. */
export interface AttentionQuestion {
  question: string
  /** A short label for the question ("Library"); empty for the brain's choices. */
  header: string
  options: { label: string; description?: string }[]
  multiSelect: boolean
}

interface AttentionViewBase {
  id: string
  /** Who is asking: "W1 api-retry · via brain" or "Brain". */
  from: string
  /** The worker that asked; absent for the brain's own requests. */
  workerId?: string
  /** Where it is answered: Needs attention, or the worker's terminal while the user is in control. */
  route: AttentionRoute
}

/** The detail of a request the card shows beyond the action text (spec 007 section 2.6). */
export type AttentionTool =
  | {
      kind: 'mcp'
      /** The MCP server, split off `mcp__<server>__<tool>`. */
      server: string
      tool: string
      /** The tool's arguments. */
      args: Record<string, unknown>
    }
  | {
      /** A Codex request for more access than its sandbox gives; decided each time, never remembered. */
      kind: 'permissions'
      reason: string
      read?: string[]
      write?: string[]
      network?: boolean
    }

/** A request that is with the user, shaped for the renderer's AttentionDialog. */
export type AttentionView =
  | (AttentionViewBase & {
      kind: 'permission'
      /** The exact action requested (mono command text). */
      action: string
      /** The brain's note for passing it on, or the policy reason. */
      reason?: string
      /** Server, tool and arguments of an MCP call, or the access a Codex request asks for. */
      tool?: AttentionTool
    })
  | (AttentionViewBase & {
      kind: 'question'
      question: string
      /**
       * A structured question: a command's AskUserQuestion call, or the brain's ask_user with
       * choices. The renderer shows buttons (checkboxes when multiSelect) and a box for the
       * user's own answer, and answers with `attention:answer` `{requestId, answers}`.
       */
      questions?: AttentionQuestion[]
    })

/** A project with uncommitted changes that needs the user's choice. */
export interface DirtyRepo {
  projectId: string
  name: string
  /** The first changed paths (at most 10), untracked files included. */
  files: string[]
  /** How many paths changed in all. */
  fileCount: number
}

export type DirtyChoiceValue = 'stash' | 'commit' | 'carry' | 'cancel'

export interface NeedsDirtyChoice {
  needsDirtyChoice: { token: string; repos: DirtyRepo[] }
}

export interface SessionSnapshot {
  header: SessionHeader
  /** Last 100 messages, oldest first. */
  messages: SessionMessage[]
  /** Last 200 events, oldest first. */
  events: SessionEventEntry[]
  workers: WorkerView[]
  plan: PlanView | null
  attention: AttentionView[]
  brainState: BrainState
  /** Files the session changed over all its repositories (change review); 0 when it could not be computed. */
  changedFileCount: number
  /**
   * Last push `seq` of this session at the time of the snapshot. The renderer drops any push
   * (`session:brain-delta`, `session:message`, `session:event-logged`, `session:brain-state`)
   * whose `seq` is at or below this value.
   */
  seq: number
}

export type CreateSessionResult = { sessionId: string } | NeedsDirtyChoice

/** `sessions:open`: the snapshot, or the dirty-repo question when a repo must leave another branch first. */
export type OpenSessionResult = SessionSnapshot | NeedsDirtyChoice

/**
 * `sessions:resolve-dirty`: `cancelled` created or switched nothing; `ready` means the session exists
 * (create) or its repos are on the session branch (open) and the renderer opens it; `carry-failed`
 * asks again with a fresh token because carrying the changes did not work.
 */
export type ResolveDirtyResult =
  | { status: 'cancelled' }
  | { status: 'ready'; sessionId: string }
  | ({ status: 'carry-failed'; message: string } & NeedsDirtyChoice)
