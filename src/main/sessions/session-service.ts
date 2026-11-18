import { randomUUID } from 'node:crypto'
import type { LoadRole } from '../../shared/types/agent-load'
import { mkdirSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AppErrorException } from '@shared/errors'
import { BRANCH_CHOICE_LABELS, recordText } from '@shared/attention-record'
import type { BranchQuestionRow } from '../db/schema'
import type { PersonalLaunchConfig } from '../personal/personal-config'
import type {
  AttentionRecordPrompt,
  BrainState,
  CliStatus,
  CreateSessionResult,
  DirtyChoiceValue,
  DirtyRepo,
  NeedsDirtyChoice,
  OpenSessionResult,
  ResolveDirtyResult,
  SessionBranch,
  SessionEventEntry,
  SessionHeader,
  SessionMessage,
  SessionMode,
  SessionSnapshot,
  SessionSummary,
  WorkerDetails,
  AttentionView,
  BranchChoiceValue
} from '@shared/types/session'
import { PLACEHOLDER_SESSION_NAME } from '@shared/types/session'
import type { InterruptOutcome, ProviderUnavailableReason } from '../agents/agent-adapter'
import type { ProviderRegistry } from '../agents/provider-registry'
import type { BridgeRegistry } from '../bridge/bridge-server'
import type { AllowRulesRepo, SessionAllowRuleRow } from '../db/repositories/allow-rules-repo'
import type { AttentionRepo } from '../db/repositories/attention-repo'
import type { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { KnowledgeSuggestionsRepo } from '../db/repositories/knowledge-suggestions-repo'
import type { KnowledgeSuggestionPort } from './knowledge-suggestion-bridge'
import { toKnowledgeSuggestionView } from '../knowledge/knowledge-suggestion-view'
import type { CommitsRepo } from '../db/repositories/commits-repo'
import type { PlansRepo } from '../db/repositories/plans-repo'
import type { WorkersRepo } from '../db/repositories/workers-repo'
import type { BranchQuestionsRepo } from '../db/repositories/branch-questions-repo'
import type { HeldMessagesRepo } from '../db/repositories/held-messages-repo'
import type { WorktreesRepo } from '../db/repositories/worktrees-repo'
import type { WorktreeGit } from '../git/worktrees'
import type { MergesRepo } from '../db/repositories/merges-repo'
import type { MergeGit } from '../git/merge'
import type { CommandCatalogue } from '../agents/command-probe'
import type { CodexCommandRunner } from '../agents/codex/codex-commands'
import type { CursorCommandRunner } from '../agents/cursor/cursor-commands'
import type { CommandInfo } from '../../shared/types/commands'
import { MergeQueue } from '../git/merge-queue'
import { sweepWorktrees } from '../git/worktree-sweep'
import type { EventsRepo } from '../db/repositories/events-repo'
import type { GroupsRepo } from '../db/repositories/groups-repo'
import { MessagesRepo } from '../db/repositories/messages-repo'
import type { ProjectsRepo } from '../db/repositories/projects-repo'
import type { BrainThreadsRepo } from '../db/repositories/brain-threads-repo'
import { SessionsRepo } from '../db/repositories/sessions-repo'
import type { SessionRow } from '../db/repositories/sessions-repo'
import { SessionProjectsRepo } from '../db/repositories/session-projects-repo'
import type { SessionProjectRow } from '../db/repositories/session-projects-repo'
import { SESSION_BRANCH_PREFIX, slugify } from '../git/session-git'
import type { SessionGit, SessionGitProject, SessionStartPlan } from '../git/session-git'
import { ulid } from '../db/ids'
import { BranchOnDemand } from './branch-on-demand'
import type { AnswerResult } from './branch-on-demand'
import { branchQuestionViews } from './branch-question-views'
import { deriveListStatus } from './list-status'
import { messageRowDto } from './message-prompt'
import type { MessageAttachmentsRepo } from '../db/repositories/message-attachments-repo'
import type { MessageRow } from '../db/repositories/messages-repo'
import { startsWithSlash } from './command-routing'
import { attachmentView } from '../attachments/attachment-send'
import { sentAttachmentsRoot } from '../attachments/attachment-paths'
import type { AttachmentSender, StoredAttachment } from '../attachments/attachment-send'
import type { MessageAttachmentView } from '@shared/attachments'
import { commandName, workerLabel } from './worker-label'
import { planView } from './plan-coordinator'
import type { AttentionAnswer, AttentionState } from './attention-coordinator'
import { attentionViews } from './attention-service'
import type { PlanDecision } from './plan-coordinator'
import { effectiveBrain, workersPrefOf } from './session-prefs'
import type { BrainChain } from './session-prefs'
import { fullestPlanPercent, providersSection } from './brain-providers'
import { ModelRegistry } from '../models/model-registry'
import type { AppSettingsRepo } from '../db/repositories/app-settings-repo'
import { modelLabel } from '@shared/provider-label'
import { brainRunningOn } from './running-on'
import { buildWorkerViews } from './worker-manager'
import type { UsageRecorder } from '../usage/usage-recorder'
import type { PlanUsageService } from '../usage/plan-usage-service'
import type { TokenTotals } from '../../shared/types/usage'
import type { WorkerManagerDeps } from './worker-manager'
import { normalizeModel } from '../models/claude-aliases'
import type {
  ModelRef,
  ProviderId,
  ProviderStatusMap,
  WorkersPref
} from '../../shared/types/provider'
import type { ReviewService } from '../review/review-service'
import type { NotesService } from '../review/notes-service'
import type { UndoService } from '../review/undo-service'
import type { PushService } from '../review/push-service'
import type {
  ReviewFileDiff,
  ReviewFileSource,
  ReviewNote,
  ReviewNoteSide,
  ReviewPushPreview,
  ReviewPushResult,
  ReviewSnapshot,
  ReviewUndoPreview
} from '../../shared/types/review'
import { readTerminalFile } from './terminal-log'
import type { RepoSettingsWarner } from '../plugins/plugin-service'
import type { TerminalBacklog } from './terminal-log'
import { runShutdown } from './shutdown'
import type { ShutdownTimings } from './shutdown'
import { BRAIN_PROMPT_VERSION, Orchestrator, buildBrainPrompt, eventDto } from './orchestrator'
import type { BrainLaunch, OrchestratorLog, OrchestratorTimings, SessionEmit } from './orchestrator'

export const SNAPSHOT_MESSAGES = 100
export const SNAPSHOT_EVENTS = 200
const NAME_MAX = 80
/** At most one `session:summary` push per session in this window. */
export const SUMMARY_PUSH_MS = 250
/** A `needsDirtyChoice` token is valid this long. */
export const DIRTY_TOKEN_TTL_MS = 10 * 60 * 1000
const DIRTY_FILES_SHOWN = 10

export interface ShutdownHooks {
  liveCount?: () => number
  signalAll?: (signal: NodeJS.Signals) => void
  /** Revokes the tokens, deletes the MCP config files and closes the bridge. */
  closeBridge?: () => Promise<void>
  /** The existing cleanup: watcher, availability checks, database. */
  cleanup?: () => void
  /** Cancels a running plugin change (`PluginService.cancelForQuit`). */
  cancelPluginOps?: () => Promise<void>
  timings?: Partial<ShutdownTimings>
}

export interface SessionServiceDeps {
  sessionsRepo: SessionsRepo
  brainThreadsRepo: BrainThreadsRepo
  messagesRepo: MessagesRepo
  eventsRepo: EventsRepo
  groupsRepo: Pick<GroupsRepo, 'getById'>
  projectsRepo: Pick<ProjectsRepo, 'listByGroup'>
  sessionProjectsRepo: SessionProjectsRepo
  sessionGit: SessionGit
  /** Questions about unsaved changes, asked before a repository gets its session branch. */
  branchQuestionsRepo: BranchQuestionsRepo
  /** A branch question opened, was answered or closed; the attention view is refreshed from this. */
  onBranchQuestionsChanged?: ((sessionId: string) => void) | undefined
  plansRepo: PlansRepo
  workersRepo: WorkersRepo
  worktreesRepo: WorktreesRepo
  heldMessagesRepo: HeldMessagesRepo
  commitsRepo: CommitsRepo
  worktreeGit: WorktreeGit
  attentionRepo: AttentionRepo
  knowledgeSuggestionsRepo: Pick<KnowledgeSuggestionsRepo, 'listWaiting'>
  /** Gives an update suggestion's target its item id in the snapshot; left out (tests), it stays null. */
  knowledgeItemsRepo?: Pick<KnowledgeItemsRepo, 'getByRelPath'> | undefined
  /** Where the brain's `suggest_knowledge_update` calls go; left out (tests), the tool is unavailable. */
  knowledgeSuggestions?: KnowledgeSuggestionPort | undefined
  /** The Settings switch "Suggest knowledge updates", read when needed; left out (tests), it is on. */
  suggestKnowledge?: (() => boolean) | undefined
  allowRulesRepo: AllowRulesRepo
  mergesRepo: MergesRepo
  mergeGit: MergeGit
  /** Read-only change review; only the file count and the full snapshot are used here. */
  reviewService: Pick<ReviewService, 'getReview' | 'getFile' | 'changedFileCount' | 'setReviewed'>
  /** Notes for the brain: drafts, sending, stale detection. */
  notesService: Pick<NotesService, 'create' | 'update' | 'delete' | 'list' | 'send'>
  /** Undo changes for one file; shares `mergeQueue` with the sessions' merges. */
  undoService: Pick<UndoService, 'preview' | 'undo'>
  /** Push branch; runs outside `mergeQueue`. */
  pushService: Pick<PushService, 'preview' | 'push'>
  /** The queue merges and undos run in; one per app. Defaults to a private queue (tests without undo). */
  mergeQueue?: MergeQueue | undefined
  /**
   * The set of requests waiting for the user in a session changed. The attention service turns this
   * into counts per session and group, the `session:attention` push and notifications.
   */
  onAttentionChanged?: (sessionId: string, state: AttentionState) => void
  /** The MCP bridge. Without it the brain runs without Arc tools. */
  bridge?: BridgeRegistry | undefined
  /** `userData/worktrees`; worker working copies live under `<sessionId>/<workerId>/<repo>`. */
  getWorktreesRoot: () => string
  getKnowledgeRoot: (groupId: string) => string
  /** Moves staged attachments into a session with their message; left out (tests), a send with files is refused. */
  /** Loads the attachments of a page of messages; left out (tests), messages carry none. */
  messageAttachmentsRepo?:
    Pick<MessageAttachmentsRepo, 'listForMessages' | 'getMany' | 'listForSession'> | undefined
  attachmentSender?: Pick<AttachmentSender, 'send' | 'sendIn'> | undefined
  /** `userData/sessions/<id>/`; removed when the session is deleted. */
  getSessionDir: (sessionId: string) => string
  /**
   * `userData/codex-brain/<id>/`: the folder a Codex brain runs in, holding its `.codex/rules/arc.rules`;
   * removed when the session is deleted. Left out, `<session folder>/codex-brain`.
   */
  getCodexBrainDir?: ((sessionId: string) => string) | undefined
  registry: ProviderRegistry
  /**
   * The models each provider offers. Left out (tests), a registry with the Claude models only is
   * used, so Codex counts as unavailable.
   */
  models?: ModelRegistry | undefined
  /** The provider statuses; with it, a Codex worker is checked again just before it spawns. */
  providers?: WorkerManagerDeps['providers']
  /** The Settings defaults that new sessions copy; left out, Auto workers and a Claude · Sonnet brain. */
  appSettings?: Pick<AppSettingsRepo, 'getProviderDefaults' | 'set' | 'get'> | undefined
  /** Called after the service saved a Settings default (the New session brain pick); pushes `settings:changed`. */
  onSettingsSaved?: (() => void) | undefined
  /** The sanitized plugin view for agents of these repositories; undefined when it could not be built. */
  getPluginViewDir?:
    ((repoPaths: readonly string[], role: LoadRole) => Promise<string | undefined>) | undefined
  /** The user's own and their plugins' MCP servers and hooks for agents (spec 007 section 2.6). */
  personal?: PersonalLaunchConfig | undefined
  /** Logs a session event once per repository whose own Claude Code settings apply in agents. */
  repoSettings?: Pick<RepoSettingsWarner, 'check'> | undefined
  /** The `/` command catalogue; without it the lists are empty. */
  commands?: Pick<CommandCatalogue, 'list'> | undefined
  /** The user's Codex skills and prompts: run by Codex workers and checked when a command is spawned. */
  codexCommands?: CodexCommandRunner | undefined
  /** The user's Cursor commands and skills: expanded into a Cursor command worker's first message. */
  cursorCommands?: CursorCommandRunner | undefined
  /** The last known Claude Code status, if any check has finished. */
  getCliStatus: () => CliStatus | undefined
  /** Runs the check again (PATH included) and publishes the result. */
  recheckCli: () => Promise<CliStatus>
  /** The brain hit an auth error: publish `providers:changed` with Claude signed out. */
  onSignedOut: () => void
  emit: SessionEmit
  now?: () => number
  newId?: () => string
  log: OrchestratorLog
  /** Test hook: timings for every orchestrator. */
  timings?: OrchestratorTimings
  /** Test hook: whether a project folder exists. */
  directoryExists?: (path: string) => boolean
  /** A Done worker is merged by Arc itself (default true; tests turn it off to merge by hand). */
  autoMergeDone?: boolean
  /** Records token usage; left out (tests), nothing is recorded and worker views carry no `tokens`. */
  usage?: UsageRecorder | undefined
  /** Receives the plan windows of agents' `rate-limit` events; left out (tests), nothing is kept. */
  planUsage?:
    (Pick<PlanUsageService, 'ingest'> & Partial<Pick<PlanUsageService, 'meters'>>) | undefined
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function branchDto(row: SessionProjectRow): SessionBranch {
  return {
    projectId: row.projectId,
    projectName: row.projectName,
    branchName: row.branchName,
    baseBranch: row.baseBranch,
    readOnly: row.readOnly,
    ...(row.membership === 'removed' ? { removed: true as const } : {})
  }
}

function headerDto(
  row: SessionRow,
  branches: SessionBranch[],
  rules: SessionAllowRuleRow[],
  status: ProviderStatusMap,
  chain: BrainChain
): SessionHeader {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    mode: row.mode,
    workerLimit: row.workerLimit,
    workers: workersPrefOf(row),
    brainModel: row.brainModel,
    brainRunningOn: brainRunningOn(row, status, chain),
    autoApprove: row.autoApprove,
    skipApprovals: row.skipApprovals,
    allowRules: rules.map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      createdAt: r.createdAt
    })),
    status: row.status,
    createdAt: row.createdAt,
    lastActiveAt: row.lastActiveAt,
    branches
  }
}

function dirtyRepoDto(info: { projectId: string; name: string; files: string[] }): DirtyRepo {
  return {
    projectId: info.projectId,
    name: info.name,
    files: info.files.slice(0, DIRTY_FILES_SHOWN),
    fileCount: info.files.length
  }
}

/** The fields of `sessions:set-config`. */
export interface SessionConfigPatch {
  mode?: SessionMode | undefined
  workerLimit?: number | undefined
  workers?: WorkersPref | undefined
  brainModel?: ModelRef | undefined
  autoApprove?: boolean | undefined
  skipApprovals?: boolean | undefined
}

interface CreateParams {
  groupId: string
  request: string
  mode: SessionMode
  workerLimit: number
  /** The brain picked in the New session dialog; left out, the Settings default applies. */
  brainModel?: ModelRef | undefined
  /** Start with Skip all approvals on; left out, the Settings default applies. */
  skipApprovals?: boolean | undefined
  /** Staged attachments of the first message; they stay staged until the session is written. */
  files?: { draftId: string; attachmentIds: readonly string[] } | undefined
}

/** What a `needsDirtyChoice` token stands for. */
type PendingDirty = {
  kind: 'open'
  sessionId: string
  /** Repos that must move to the session branch; `dirty` ones need a choice. */
  repos: { projectId: string; name: string; path: string; branch: string; dirty: boolean }[]
  expiresAt: number
}

/** What changed in a group (functional spec 2.11). */
export type GroupChange = { kind: 'projects' } | { kind: 'knowledge' }

function summaryDto(
  row: SessionRow,
  brainState: BrainState,
  pendingAttention: number
): SessionSummary {
  return {
    id: row.id,
    groupId: row.groupId,
    name: row.name,
    lastActiveAt: row.lastActiveAt,
    status: row.status,
    listStatus: deriveListStatus({ sessionStatus: row.status, brainState, pendingAttention }),
    attentionCount: pendingAttention,
    skipApprovals: row.skipApprovals
  }
}

function summaryKey(s: SessionSummary): string {
  return `${s.listStatus}|${s.name}|${s.lastActiveAt}|${s.attentionCount}|${s.skipApprovals}`
}

/** The IPC-facing sessions service: persistence plus one orchestrator per session that has a brain. */
export class SessionService {
  private readonly orchestrators = new Map<string, Orchestrator>()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly summaryTimers = new Map<string, NodeJS.Timeout>()
  private readonly lastSummaryKey = new Map<string, string>()
  private closed = false
  private readonly pendingDirty = new Map<string, PendingDirty>()
  private readonly branchStarts = new Map<string, Promise<void>>()
  /** Group changes of one session run one at a time. */
  private readonly groupSyncs = new Map<string, Promise<unknown>>()
  /** The knowledge folder each open session's brain was last told about. */
  private readonly knownKnowledge = new Map<string, string>()
  /** One queue for every session: merges of a repository run one at a time. */
  private readonly mergeQueue: MergeQueue
  /** Creates a session branch in a repository when a worker first needs it; the worker manager calls `ensure`. */
  readonly branchOnDemand: BranchOnDemand

  /** The models providers offer; shared by every session's workers and the pickers. */
  private readonly models: ModelRegistry

  constructor(private readonly deps: SessionServiceDeps) {
    this.models = deps.models ?? new ModelRegistry({ status: () => deps.providers?.get() ?? {} })
    this.mergeQueue = deps.mergeQueue ?? new MergeQueue()
    this.now = deps.now ?? Date.now
    this.branchOnDemand = new BranchOnDemand({
      sessionsRepo: deps.sessionsRepo,
      sessionProjectsRepo: deps.sessionProjectsRepo,
      workersRepo: deps.workersRepo,
      branchQuestionsRepo: deps.branchQuestionsRepo,
      sessionGit: deps.sessionGit,
      logEvent: (sessionId, kind, text, data, workerId) =>
        this.logSessionEvent(sessionId, kind, text, data, workerId),
      pushHeader: (sessionId) => this.pushHeader(sessionId),
      drain: (sessionId) => this.orchestrators.get(sessionId)?.drainWorkers(),
      onWorkersChanged: (sessionId, workerIds) =>
        this.orchestrators.get(sessionId)?.workersChanged(workerIds),
      notifyBrain: (sessionId, text) => this.orchestrators.get(sessionId)?.sendNote(text),
      onQuestionsChanged: (sessionId) => {
        // The badge on the session list counts these questions.
        this.scheduleSummary(sessionId)
        this.deps.onBranchQuestionsChanged?.(sessionId)
      },
      now: () => this.now(),
      log: deps.log
    })
    this.newId = deps.newId ?? (() => ulid(this.now()))
  }

  /**
   * The user's answer to an unsaved-changes question (`sessions:answer-branch-question`). The record
   * is posted when the answer is accepted, before the worker starts, so later messages land below it.
   * A choice that then fails changes the same line to "did not work".
   */
  async answerBranchQuestion(questionId: string, choice: BranchChoiceValue): Promise<AnswerResult> {
    // Read before answering: the record names the project, and the question may close meanwhile.
    const question = this.deps.branchQuestionsRepo.getById(questionId)
    let recorded: { messageId: number; prompt: AttentionRecordPrompt } | undefined
    const result = await this.branchOnDemand.answer(questionId, choice, () => {
      if (question) recorded = this.recordBranchAnswer(question, choice)
    })
    if (result.status === 'failed' && recorded && question) {
      const failed: AttentionRecordPrompt = { ...recorded.prompt, failed: true }
      this.orchestrators
        .get(question.sessionId)
        ?.updateSystemMessage(recorded.messageId, recordText(failed), failed)
    }
    return result
  }

  /** One line in the conversation for an unsaved-changes choice, posted at the click. */
  private recordBranchAnswer(
    question: BranchQuestionRow,
    choice: BranchChoiceValue
  ): { messageId: number; prompt: AttentionRecordPrompt } | undefined {
    const project = this.deps.sessionProjectsRepo
      .listBySession(question.sessionId)
      .find((p) => p.id === question.sessionProjectId)
    const orchestrator = this.orchestrators.get(question.sessionId)
    if (!project || !orchestrator) return undefined
    const prompt: AttentionRecordPrompt = {
      kind: 'attention-record',
      decision: 'branch',
      subject: project.projectName,
      answer: BRANCH_CHOICE_LABELS[choice],
      from: 'Arc'
    }
    return { messageId: orchestrator.postSystemMessage(recordText(prompt), prompt), prompt }
  }

  /** Closes the questions no worker waits on (a worker was stopped or removed, a project left, a session opened). */
  private async cancelBranchOrphans(sessionId: string): Promise<void> {
    try {
      await this.branchOnDemand.cancelOrphans(sessionId)
    } catch (error: unknown) {
      this.deps.log.warn('could not close the unsaved-changes questions nobody waits on', error)
    }
  }

  /** The cards of the session's open unsaved-changes questions, with the changed files read now. */
  branchQuestionViews(sessionId: string): Promise<AttentionView[]> {
    return branchQuestionViews(
      {
        branchQuestionsRepo: this.deps.branchQuestionsRepo,
        sessionProjectsRepo: this.deps.sessionProjectsRepo,
        workersRepo: this.deps.workersRepo,
        sessionGit: this.deps.sessionGit,
        log: this.deps.log
      },
      sessionId
    )
  }

  list(groupId: string): SessionSummary[] {
    return this.deps.sessionsRepo.listByGroup(groupId).map((row) => this.summaryOf(row))
  }

  private summaryOf(row: SessionRow): SessionSummary {
    return summaryDto(
      row,
      this.orchestrators.get(row.id)?.brainState ?? 'idle',
      this.deps.attentionRepo.countPendingEscalatedBySession(row.id) +
        this.deps.branchQuestionsRepo.countPending(row.id)
    )
  }

  /** Pushes `session:summary` when the derived status, name or activity time changed; throttled per session. */
  private scheduleSummary(sessionId: string): void {
    if (this.closed || this.summaryTimers.has(sessionId)) return
    const timer = setTimeout(() => {
      this.summaryTimers.delete(sessionId)
      const row = this.deps.sessionsRepo.getById(sessionId)
      if (!row) return
      // A card lists the workers that wait on it, and those change after the card opens.
      if (this.deps.branchQuestionsRepo.countPending(sessionId) > 0) {
        this.deps.onBranchQuestionsChanged?.(sessionId)
      }
      const summary = this.summaryOf(row)
      const key = summaryKey(summary)
      if (this.lastSummaryKey.get(sessionId) === key) return
      this.lastSummaryKey.set(sessionId, key)
      this.deps.emit('session:summary', { groupId: row.groupId, summary })
    }, SUMMARY_PUSH_MS)
    this.summaryTimers.set(sessionId, timer)
  }

  /**
   * Starts a session. No repository is touched and nothing is asked about unsaved changes: the
   * brain's title (or the fallback name) only chooses the branch name (`startBranches`), and a
   * repository gets its session branch when a worker first needs it.
   */
  async create(
    groupId: string,
    request: string,
    mode: SessionMode,
    workerLimit: number,
    brainModel?: ModelRef,
    files?: { draftId: string; attachmentIds: readonly string[] },
    skipApprovals?: boolean
  ): Promise<CreateSessionResult> {
    const text = request.trim()
    const hasFiles = files !== undefined && files.attachmentIds.length > 0
    if (text === '' && !hasFiles) throw new AppErrorException('VALIDATION_FAILED')
    if (hasFiles && !this.deps.attachmentSender) throw new AppErrorException('VALIDATION_FAILED')
    // Refused before anything exists; the staged files stay for the renderer to retry.
    if (hasFiles && startsWithSlash(text)) throw new AppErrorException('ATTACHMENTS_WITH_COMMAND')
    // The same rule as `setConfig`: a Codex or Cursor brain must be one the provider lists now.
    if (brainModel !== undefined && !this.models.has(brainModel)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    if (!this.deps.groupsRepo.getById(groupId)) throw new AppErrorException('INTERNAL')
    // Nothing is persisted when Claude Code is unavailable: the renderer keeps the draft.
    await this.ensureCli()

    const params: CreateParams = {
      groupId,
      request: text,
      mode,
      workerLimit,
      ...(brainModel ? { brainModel } : {}),
      ...(skipApprovals !== undefined ? { skipApprovals } : {}),
      ...(hasFiles ? { files } : {})
    }
    return { sessionId: await this.startSession(params, this.gitProjects(groupId)) }
  }

  private async planFor(projects: SessionGitProject[]): Promise<SessionStartPlan> {
    try {
      return await this.deps.sessionGit.planSessionStart(projects)
    } catch (error: unknown) {
      // The branch step reports a broken repository later; starting the conversation still works.
      this.deps.log.warn('could not check the projects for unsaved changes', error)
      return { projects, dirtyRepos: [] }
    }
  }

  private gitProjects(groupId: string): SessionGitProject[] {
    const exists = this.deps.directoryExists ?? isDirectory
    return this.deps.projectsRepo
      .listByGroup(groupId)
      .filter((p) => exists(p.path))
      .map((p) => ({ projectId: p.id, name: p.displayName, path: p.path, isGit: p.isGit }))
  }

  private askDirty(
    pending: PendingDirty,
    repos: { projectId: string; name: string; files: string[] }[]
  ): NeedsDirtyChoice {
    this.purgeTokens()
    const token = randomUUID()
    this.pendingDirty.set(token, { ...pending, expiresAt: this.now() + DIRTY_TOKEN_TTL_MS })
    return { needsDirtyChoice: { token, repos: repos.map(dirtyRepoDto) } }
  }

  private purgeTokens(): void {
    const now = this.now()
    for (const [token, pending] of this.pendingDirty) {
      if (pending.expiresAt <= now) this.pendingDirty.delete(token)
    }
  }

  private takeToken(token: string): PendingDirty {
    this.purgeTokens()
    const pending = this.pendingDirty.get(token)
    if (!pending) throw new AppErrorException('VALIDATION_FAILED')
    this.pendingDirty.delete(token)
    return pending
  }

  /**
   * Writes the session, its project rows and the first message, and starts the brain. With
   * attachments the staged files are copied first and everything is written in one transaction;
   * on a failure nothing remains but the staged files, so the user can retry.
   */
  private async startSession(params: CreateParams, projects: SessionGitProject[]): Promise<string> {
    const now = this.now()
    const sessionId = this.newId()
    // A new session copies the Settings defaults; changing Settings later never touches it.
    const stored = this.deps.appSettings?.getProviderDefaults() ?? {
      brain: { provider: 'claude' as const, model: 'sonnet' },
      workers: { mode: 'auto' as const }
    }
    const picked = params.brainModel
      ? { provider: params.brainModel.provider, model: normalizeModel(params.brainModel.model) }
      : undefined
    const defaults = { ...stored, brain: picked ?? stored.brain }
    const skipApprovals =
      params.skipApprovals ?? this.deps.appSettings?.get('approvals.skipAllByDefault') ?? false
    const sessionRow = {
      id: sessionId,
      groupId: params.groupId,
      name: PLACEHOLDER_SESSION_NAME,
      slug: null,
      mode: params.mode,
      workerLimit: params.workerLimit,
      model: 'auto',
      workersPrefJson: JSON.stringify(defaults.workers),
      brainProvider: defaults.brain.provider,
      brainModel: defaults.brain.model,
      status: 'active',
      brainPromptVersion: BRAIN_PROMPT_VERSION,
      skipApprovals,
      createdAt: now,
      lastActiveAt: now
    } as const
    // Non-git projects are read only from the start; git projects get a branch when a worker first needs one.
    const projectRows = projects.map((p) => ({
      sessionId,
      projectId: p.projectId,
      readOnly: !p.isGit,
      projectPath: p.path,
      projectName: p.name
    }))
    const firstMessage = {
      sessionId,
      role: 'user',
      content: params.request,
      state: 'complete',
      planId: null,
      createdAt: now,
      updatedAt: now
    } as const
    const sender = params.files ? this.deps.attachmentSender : undefined
    let sentFiles: StoredAttachment[] = []
    if (params.files && sender) {
      try {
        const sent = await sender.sendIn({
          sessionId,
          draftId: params.files.draftId,
          ids: params.files.attachmentIds,
          write: (tx) => {
            new SessionsRepo(tx).create(sessionRow)
            new SessionProjectsRepo(tx).insertMany(projectRows)
            return new MessagesRepo(tx).append(firstMessage)
          }
        })
        sentFiles = sent.attachments
      } catch (error: unknown) {
        // The copies' folder goes with the session folder; the staged files stay for a retry.
        await this.removeSessionDir(sessionId)
        throw error
      }
    } else {
      this.deps.sessionsRepo.create(sessionRow)
      this.deps.sessionProjectsRepo.insertMany(projectRows)
    }
    this.attachmentsDirOf(sessionId)
    // The pick is remembered: the next New session dialog and the Providers page show it.
    if (picked && this.deps.appSettings) {
      this.deps.appSettings.set('providers.brain', picked, now)
      this.deps.onSettingsSaved?.()
    }
    if (!params.files) this.deps.messagesRepo.append(firstMessage)
    const orchestrator = this.orchestratorFor(sessionId, params.request)
    if (skipApprovals) {
      orchestrator.logEvent('skip-approvals', 'Session started with Skip all approvals on', {
        skipApprovals: true
      })
    }
    this.deliver(sessionId, orchestrator, params.request, sentFiles)
    this.scheduleSummary(sessionId)
    return sessionId
  }

  /**
   * The brain named the session: choose the branch name (tech spec 2.1). No repository is changed;
   * `sessions.slug` only means "the name is chosen".
   */
  private startBranches(sessionId: string, name: string): Promise<void> {
    const running = this.branchStarts.get(sessionId)
    if (running) return running
    const task = this.runBranchStart(sessionId, name)
      .catch((error: unknown) => {
        this.deps.log.error('could not create the session branches', error)
        this.reportBranchFailure(
          sessionId,
          "Arc couldn't choose a working branch name for this session. Your repositories were not changed."
        )
      })
      .finally(() => {
        this.branchStarts.delete(sessionId)
      })
    this.branchStarts.set(sessionId, task)
    return task
  }

  private async runBranchStart(sessionId: string, name: string): Promise<void> {
    const row = this.deps.sessionsRepo.getById(sessionId)
    if (!row || row.slug !== null) return
    const paths = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter((r) => !r.readOnly && r.projectId !== null && r.membership === 'active')
      .map((r) => r.projectPath)
    // Read only: the name avoids a branch an older session left in any repository.
    const branchName =
      paths.length === 0
        ? SESSION_BRANCH_PREFIX + slugify(name)
        : await this.deps.sessionGit.uniqueBranch(paths, slugify(name))
    if (!this.deps.sessionsRepo.getById(sessionId)) return
    this.deps.sessionsRepo.setSlug(sessionId, branchName.slice(SESSION_BRANCH_PREFIX.length))
  }

  private reportBranchFailure(sessionId: string, text: string): void {
    const orchestrator = this.orchestrators.get(sessionId)
    orchestrator?.logEvent('branch-failed', text)
    orchestrator?.postSystemMessage(text)
  }

  private pushHeader(sessionId: string): void {
    const row = this.deps.sessionsRepo.getById(sessionId)
    if (!row) return
    this.orchestrators.get(sessionId)?.pushHeader(this.headerOf(row))
  }

  private headerOf(row: SessionRow): SessionHeader {
    return headerDto(
      row,
      this.deps.sessionProjectsRepo
        .listBySession(row.id)
        .filter((r) => r.membership !== 'left_out')
        .map(branchDto),
      this.deps.allowRulesRepo.listBySession(row.id),
      this.deps.providers?.get() ?? {},
      {
        limited: this.orchestrators.get(row.id)?.limitedProviders,
        defaultFor: (p) => this.models.defaultFor(p)
      }
    )
  }

  /** The user answered the dirty-tree question (`sessions:resolve-dirty`). */
  async resolveDirty(
    token: string,
    choices: Record<string, DirtyChoiceValue>
  ): Promise<ResolveDirtyResult> {
    return this.resolveOpen(this.takeToken(token), choices)
  }

  private async resolveOpen(
    pending: Extract<PendingDirty, { kind: 'open' }>,
    choices: Record<string, DirtyChoiceValue>
  ): Promise<ResolveDirtyResult> {
    const dirty = pending.repos.filter((r) => r.dirty)
    if (dirty.some((r) => (choices[r.projectId] ?? 'cancel') === 'cancel')) {
      return { status: 'cancelled' }
    }
    // Carry first: it is the one that can fail without having changed anything.
    const ordered = [...pending.repos].sort(
      (a, b) => Number(choices[b.projectId] === 'carry') - Number(choices[a.projectId] === 'carry')
    )
    for (const repo of ordered) {
      const outcome = await this.deps.sessionGit.checkoutSessionBranch(
        repo.path,
        repo.branch,
        repo.dirty ? choices[repo.projectId] : undefined
      )
      if (outcome.status === 'carry-failed') {
        this.deps.log.warn(`carry failed on reopen: ${outcome.message}`)
        const next = await this.prepareOpen(pending.sessionId)
        if (next === null) return { status: 'ready', sessionId: pending.sessionId }
        return {
          status: 'carry-failed',
          message: `Arc couldn't bring your unsaved changes in ${repo.name} onto the session branch. Choose another way to handle them.`,
          ...next
        }
      }
      if (outcome.status === 'switched' && outcome.dirtyHandling !== 'none') {
        this.deps.sessionProjectsRepo.setDirtyHandling(
          pending.sessionId,
          repo.projectId,
          outcome.dirtyHandling,
          outcome.stashRef
        )
      }
    }
    return { status: 'ready', sessionId: pending.sessionId }
  }

  /**
   * Reopen: finds the repos that are not on the session branch. Returns null when every repo is
   * (or could be switched without asking); otherwise a dirty-choice question and nothing is switched.
   */
  private async prepareOpen(sessionId: string): Promise<NeedsDirtyChoice | null> {
    const exists = this.deps.directoryExists ?? isDirectory
    const off: Extract<PendingDirty, { kind: 'open' }>['repos'] = []
    const files = new Map<string, string[]>()
    for (const r of this.deps.sessionProjectsRepo.listBySession(sessionId)) {
      if (
        r.readOnly ||
        r.membership !== 'active' ||
        r.branchName === null ||
        r.projectId === null ||
        !exists(r.projectPath)
      ) {
        continue
      }
      try {
        if ((await this.deps.sessionGit.currentBranch(r.projectPath)) === r.branchName) continue
        const status = await this.deps.sessionGit.checkDirty(r.projectPath)
        files.set(r.projectId, status.files)
        off.push({
          projectId: r.projectId,
          name: r.projectName,
          path: r.projectPath,
          branch: r.branchName,
          dirty: status.dirty
        })
      } catch (error: unknown) {
        this.deps.log.warn(`could not check ${r.projectName} on reopen`, error)
      }
    }
    if (off.length === 0) return null
    const dirtyRepos = off.filter((r) => r.dirty)
    const pending: PendingDirty = { kind: 'open', sessionId, repos: off, expiresAt: 0 }
    if (dirtyRepos.length === 0) {
      // Nothing to ask: clean repos just move to the session branch.
      await this.switchClean(pending)
      return null
    }
    return this.askDirty(
      pending,
      dirtyRepos.map((r) => ({
        projectId: r.projectId,
        name: r.name,
        files: files.get(r.projectId) ?? []
      }))
    )
  }

  private async switchClean(pending: Extract<PendingDirty, { kind: 'open' }>): Promise<void> {
    for (const repo of pending.repos) {
      try {
        await this.deps.sessionGit.checkoutSessionBranch(repo.path, repo.branch)
      } catch (error: unknown) {
        // The branch may have been deleted by hand; the session still opens.
        this.deps.log.warn(`could not switch ${repo.name} to ${repo.branch}`, error)
      }
    }
  }

  // ---- group changes (functional spec 2.11) ----

  /** True while any open session waits for this provider's usage limit (the Claude plan check stays away then). */
  anyRateLimitWaiting(provider: ProviderId): boolean {
    return [...this.orchestrators.values()].some((o) => o.isRateLimitWaiting(provider))
  }

  /**
   * The group's projects or knowledge folder changed. Every open session of the group (`null`: of
   * any group) takes the change: added projects join with their session branch, removed ones are
   * marked, moved ones are used at the new path, and the brain is refreshed at its next pause.
   * Sessions that are not open take it when they are opened.
   */
  async groupChanged(groupId: string | null, change: GroupChange): Promise<void> {
    if (this.closed) return
    const ids = [...this.orchestrators.keys()].filter(
      (id) => groupId === null || this.deps.sessionsRepo.getById(id)?.groupId === groupId
    )
    await Promise.all(
      ids.map((id) =>
        this.serial(id, () => this.applyGroupChange(id, change)).catch((error: unknown) =>
          this.deps.log.error('could not apply the group change to a session', error)
        )
      )
    )
  }

  private serial<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.groupSyncs.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    const tail = next.catch(() => undefined)
    this.groupSyncs.set(sessionId, tail)
    void tail.then(() => {
      if (this.groupSyncs.get(sessionId) === tail) this.groupSyncs.delete(sessionId)
    })
    return next
  }

  private async applyGroupChange(sessionId: string, change: GroupChange): Promise<void> {
    const session = this.deps.sessionsRepo.getById(sessionId)
    if (!session || this.closed) return
    const lines: string[] = []
    if (change.kind === 'projects') {
      lines.push(...(await this.syncProjects(sessionId)))
    } else {
      const root = this.deps.getKnowledgeRoot(session.groupId)
      const before = this.knownKnowledge.get(sessionId)
      if (before !== undefined && before !== root) {
        this.knownKnowledge.set(sessionId, root)
        lines.push(`the knowledge folder is now ${root}`)
        this.logSessionEvent(sessionId, 'knowledge-changed', `Knowledge folder is now ${root}`, {
          root
        })
      }
    }
    if (change.kind === 'projects') await this.warnRepoSettings(sessionId)
    if (lines.length === 0) return
    this.tellBrain(sessionId, lines)
  }

  /** Spec 005: a repository's own hooks and enabled plugins apply in its workers; say so once. */
  private async warnRepoSettings(sessionId: string): Promise<void> {
    const warner = this.deps.repoSettings
    if (!warner) return
    try {
      const session = this.deps.sessionsRepo.getById(sessionId)
      if (!session) return
      const exists = this.deps.directoryExists ?? isDirectory
      const repos = this.deps.projectsRepo
        .listByGroup(session.groupId)
        .filter((p) => exists(p.path))
        .map((p) => ({ name: p.displayName, path: p.path }))
      await warner.check(sessionId, repos, (kind, text) =>
        this.logSessionEvent(sessionId, kind, text)
      )
    } catch (error: unknown) {
      this.deps.log.warn('could not check the repositories for their own Claude settings', error)
    }
  }

  private tellBrain(sessionId: string, lines: string[]): void {
    const session = this.deps.sessionsRepo.getById(sessionId)
    if (!session || lines.length === 0) return
    const exists = this.deps.directoryExists ?? isDirectory
    const projects = this.deps.projectsRepo
      .listByGroup(session.groupId)
      .filter((p) => exists(p.path))
      .map((p) => `${p.displayName} (${p.path})`)
    const root = this.deps.getKnowledgeRoot(session.groupId)
    this.knownKnowledge.set(sessionId, root)
    const note =
      `[Arc] The group changed: ${lines.join('; ')}. ` +
      `Projects now: ${projects.length > 0 ? projects.join(', ') : 'none'}. ` +
      `The knowledge folder is ${root}. Use these folders from now on.`
    this.orchestratorFor(sessionId, null).groupChanged(note)
  }

  /** Writes a session event for a service outside the session engine; no orchestrator is needed. */
  logEvent(sessionId: string, kind: string, text: string, data?: unknown): void {
    this.logSessionEvent(sessionId, kind, text, data)
  }

  /**
   * The user discarded knowledge suggestions of the session: a running session's brain is told with its next
   * message. Nothing happens, and nothing is kept, for a session that has no orchestrator.
   */
  knowledgeDiscarded(sessionId: string, titles: readonly string[]): void {
    this.orchestrators.get(sessionId)?.recordSuggestionsDiscarded(titles)
  }

  /**
   * The user saved a new value for "Suggest knowledge updates" (`settings:set`): every open session whose brain is
   * running hears about it with its next message. Brains started later read the switch into their prompt.
   */
  knowledgeSuggestSettingChanged(): void {
    for (const orchestrator of this.orchestrators.values()) orchestrator.suggestSettingChanged()
  }

  private logSessionEvent(
    sessionId: string,
    kind: string,
    text: string,
    data?: unknown,
    workerId?: string
  ): void {
    const orchestrator = this.orchestrators.get(sessionId)
    if (orchestrator) {
      orchestrator.logEvent(kind, text, data, workerId ?? null)
      return
    }
    this.deps.eventsRepo.append({
      sessionId,
      at: this.now(),
      kind,
      text,
      workerId: workerId ?? null,
      dataJson: data === undefined ? null : JSON.stringify(data)
    })
  }

  /**
   * Brings the session's project rows in line with the group. Returns what the brain should be told.
   * A removed project keeps its row (history and review stay); a moved one gets its new path.
   */
  private async syncProjects(sessionId: string): Promise<string[]> {
    // The first branch start reads the rows once; wait for it so no project is missed.
    const running = this.branchStarts.get(sessionId)
    if (running) await running
    const session = this.deps.sessionsRepo.getById(sessionId)
    if (!session || this.closed) return []
    const repo = this.deps.sessionProjectsRepo
    const exists = this.deps.directoryExists ?? isDirectory
    const group = this.deps.projectsRepo.listByGroup(session.groupId)
    const inGroup = new Map(group.map((p) => [p.id, p]))
    const lines: string[] = []
    let rowsChanged = false

    for (const row of repo.listBySession(sessionId)) {
      const project = row.projectId === null ? undefined : inGroup.get(row.projectId)
      if (!project) {
        if (row.membership === 'active') {
          repo.setMembership(row.id, 'removed')
          rowsChanged = true
          lines.push(
            `"${row.projectName}" was removed from the group, so start no new workers there`
          )
          this.logSessionEvent(
            sessionId,
            'project-removed',
            `${row.projectName} was removed from the group; workers already running there keep going`,
            { projectName: row.projectName }
          )
        } else if (row.membership === 'left_out') {
          repo.delete(row.id)
        }
        continue
      }
      if (row.membership === 'removed') {
        repo.setMembership(row.id, 'active')
        rowsChanged = true
        lines.push(`"${project.displayName}" is part of the group again`)
        this.logSessionEvent(
          sessionId,
          'project-added',
          `${project.displayName} is part of the group again`
        )
      }
      if (row.projectPath !== project.path) {
        repo.setLocation(row.id, project.path, project.displayName)
        rowsChanged = true
        lines.push(
          `"${row.projectName}" moved to ${project.path}${
            row.projectName === project.displayName ? '' : ` (now called "${project.displayName}")`
          }; workers started from now on use the new folder`
        )
        this.logSessionEvent(
          sessionId,
          'project-moved',
          `${row.projectName} moved to ${project.path}`,
          { projectName: row.projectName, path: project.path }
        )
      }
    }

    const known = new Set(repo.listBySession(sessionId).map((r) => r.projectId))
    const fresh = group.filter((p) => !known.has(p.id) && exists(p.path))
    if (fresh.length > 0) {
      repo.insertMany(
        fresh.map((p) => ({
          sessionId,
          projectId: p.id,
          readOnly: !p.isGit,
          projectPath: p.path,
          projectName: p.displayName
        }))
      )
      rowsChanged = true
      for (const p of fresh) {
        if (p.isGit) {
          lines.push(
            `"${p.displayName}" joined the group (${p.path}); it gets the session branch when a worker first starts there`
          )
          this.logSessionEvent(
            sessionId,
            'project-added',
            `${p.displayName} joined the group; it gets the session branch when a worker first starts there`
          )
          continue
        }
        lines.push(
          `"${p.displayName}" joined the group (${p.path}); it is read only, not a git repository`
        )
        this.logSessionEvent(
          sessionId,
          'project-added',
          `${p.displayName} joined the group (read only)`
        )
      }
    }
    if (rowsChanged) this.pushHeader(sessionId)
    // A project that left the group takes its unsaved-changes question with it. Opening a session
    // runs this too, so a card whose workers are gone while Arc was closed disappears on open.
    await this.cancelBranchOrphans(sessionId)

    return lines
  }

  async open(sessionId: string): Promise<OpenSessionResult> {
    this.requireSession(sessionId)
    // The group may have changed while this session was not open.
    await this.serial(sessionId, () => this.applyGroupChange(sessionId, { kind: 'projects' }))
    const question = await this.prepareOpen(sessionId)
    if (question) return question
    // A session whose name was never turned into a branch name (an aborted start) gets one now.
    const named = this.requireSession(sessionId)
    if (named.slug === null && named.name !== PLACEHOLDER_SESSION_NAME) {
      void this.startBranches(sessionId, named.name)
    }
    // A fast-forward that waited for a clean checkout may be possible now. Opening never waits for
    // it: the retry runs in the background and its result arrives as a normal session event.
    this.orchestratorFor(sessionId, null).offerContinue()
    void this.orchestratorFor(sessionId, null)
      .retryPendingMerges()
      .catch((error: unknown) =>
        this.deps.log.warn('could not retry the session branch update', error)
      )
    // Warm the command list for the message box; opening never waits for it.
    void this.listCommands(sessionId, false).catch((error: unknown) =>
      this.deps.log.warn('could not warm the command list', error)
    )
    const snapshot = this.snapshot(sessionId)
    return {
      ...snapshot,
      attention: [...snapshot.attention, ...(await this.branchQuestionViews(sessionId))],
      changedFileCount: await this.changedFileCountOf(sessionId)
    }
  }

  /** `commands:list` and `commands:refresh`. */
  async listCommands(sessionId: string, refresh: boolean): Promise<CommandInfo[]> {
    const session = this.requireSession(sessionId)
    if (!this.deps.commands) return []
    const exists = this.deps.directoryExists ?? isDirectory
    const repos = this.deps.sessionProjectsRepo
      .listBySession(sessionId)
      .filter((r) => r.membership === 'active' && exists(r.projectPath))
      .map((r) => ({ name: r.projectName, path: r.projectPath }))
    return this.deps.commands.list({
      repos,
      fallbackCwd: this.brainCwdOf(session),
      refresh
    })
  }

  /**
   * Plugins were installed, updated or removed: every open session's brain hears about the new
   * command list with its next message (one note, however many changes come before it).
   */
  async pluginsChanged(): Promise<void> {
    await Promise.all(
      [...this.orchestrators.keys()].map(async (sessionId) => {
        try {
          const commands = await this.listCommands(sessionId, false)
          this.orchestrators.get(sessionId)?.commandsChanged(commands)
        } catch (error: unknown) {
          this.deps.log.warn('could not tell a brain about the plugin change', error)
        }
      })
    )
  }

  /** `review:get`. */
  getReview(sessionId: string): Promise<ReviewSnapshot> {
    this.requireSession(sessionId)
    return Promise.all([
      this.deps.reviewService.getReview(sessionId),
      this.deps.notesService.list(sessionId)
    ]).then(([snapshot, notes]) => ({ ...snapshot, notes }))
  }

  /** `review:note-create`. */
  createNote(input: {
    sessionId: string
    projectId: string
    path: string
    side: ReviewNoteSide
    line: number
    lineText: string
    body: string
  }): Promise<ReviewNote> {
    this.requireSession(input.sessionId)
    return this.deps.notesService.create(input)
  }

  /** `review:note-update`. */
  updateNote(noteId: string, body: string): Promise<ReviewNote> {
    return this.deps.notesService.update(noteId, body)
  }

  /** `review:note-delete`. */
  deleteNote(noteId: string): void {
    this.deps.notesService.delete(noteId)
  }

  /** `review:send-notes`: the drafts as one visible message to the brain. */
  sendReviewNotes(sessionId: string): Promise<{ messageId: number; count: number }> {
    this.requireSession(sessionId)
    return this.deps.notesService.send(sessionId, (id, text) => this.sendMessage(id, text))
  }

  /** `review:file`. */
  getReviewFile(
    sessionId: string,
    projectId: string,
    path: string,
    showAnyway: boolean,
    source: ReviewFileSource = 'session'
  ): Promise<ReviewFileDiff> {
    this.requireSession(sessionId)
    return this.deps.reviewService.getFile(sessionId, projectId, path, showAnyway, source)
  }

  /** `review:set-reviewed`. */
  setReviewed(
    sessionId: string,
    projectId: string,
    path: string,
    reviewed: boolean
  ): Promise<void> {
    this.requireSession(sessionId)
    return this.deps.reviewService.setReviewed(sessionId, projectId, path, reviewed)
  }

  /** `review:undo-preview`. */
  undoPreview(sessionId: string, projectId: string, path: string): Promise<ReviewUndoPreview> {
    this.requireSession(sessionId)
    return this.deps.undoService.preview(sessionId, projectId, path)
  }

  /** `review:undo`: restores the file in a new commit, then logs it, tells the brain and refreshes the review. */
  async undoFile(sessionId: string, projectId: string, path: string): Promise<void> {
    this.requireSession(sessionId)
    const result = await this.deps.undoService.undo(sessionId, projectId, path)
    this.orchestratorFor(sessionId, null).recordUndo(result)
  }

  /** `review:push-preview`. */
  pushPreview(sessionId: string, projectId: string): Promise<ReviewPushPreview> {
    this.requireSession(sessionId)
    return this.deps.pushService.preview(sessionId, projectId)
  }

  /** `review:push`: pushes the session branch, then logs it and refreshes the review. */
  async pushBranch(sessionId: string, projectId: string): Promise<ReviewPushResult> {
    this.requireSession(sessionId)
    const outcome = await this.deps.pushService.push(sessionId, projectId)
    this.orchestratorFor(sessionId, null).recordPush(outcome)
    return { pushedAt: outcome.pushedAt, remote: outcome.remote, sha: outcome.sha }
  }

  /** Read-only git; a failure must never fail `sessions:open`, so it counts as 0. */
  private async changedFileCountOf(sessionId: string): Promise<number> {
    try {
      return await this.deps.reviewService.changedFileCount(sessionId)
    } catch (error: unknown) {
      this.deps.log.warn('could not count the changed files', error)
      return 0
    }
  }

  /** Message DTOs with their attachments, loaded in one query for the whole batch. */
  private messageDtos(rows: MessageRow[]): SessionMessage[] {
    const repo = this.deps.messageAttachmentsRepo
    const byMessage = repo?.listForMessages(rows.map((r) => r.id))
    return rows.map((r) => messageRowDto(r, byMessage?.get(r.id)))
  }

  /** The snapshot without the branch check (`open` adds it). */
  snapshot(sessionId: string): SessionSnapshot {
    const orchestrator = this.orchestrators.get(sessionId)
    const prepared = orchestrator?.prepareSnapshot() ?? { seq: 0, brainState: 'idle' as const }
    const row = this.requireSession(sessionId)
    return {
      header: this.headerOf(row),
      messages: this.messageDtos(this.deps.messagesRepo.latest(sessionId, SNAPSHOT_MESSAGES)),
      events: this.deps.eventsRepo.latest(sessionId, SNAPSHOT_EVENTS).map(eventDto),
      workers:
        orchestrator?.workerViews ??
        buildWorkerViews(
          sessionId,
          this.deps.workersRepo,
          this.deps.worktreesRepo,
          this.deps.sessionProjectsRepo,
          this.deps.commitsRepo,
          undefined,
          undefined,
          this.tokensOf(sessionId),
          this.deps.usage?.inFlightOf(sessionId)
        ),
      plan: ((row) => (row ? planView(row) : null))(this.deps.plansRepo.latest(sessionId)),
      attention: attentionViews(this.deps.attentionRepo.listPendingEscalated(sessionId), (id) =>
        this.deps.workersRepo.get(id)
      ),
      knowledgeSuggestions: this.deps.knowledgeSuggestionsRepo
        .listWaiting(sessionId)
        .map((row) =>
          toKnowledgeSuggestionView(
            row,
            (relPath) => this.deps.knowledgeItemsRepo?.getByRelPath(row.groupId, relPath)?.id
          )
        ),
      brainState: prepared.brainState,
      changedFileCount: 0,
      seq: prepared.seq
    }
  }

  rename(sessionId: string, name: string): SessionSummary {
    const trimmed = name.trim()
    if (trimmed === '' || trimmed.length > NAME_MAX)
      throw new AppErrorException('VALIDATION_FAILED')
    this.requireSession(sessionId)
    this.deps.sessionsRepo.rename(sessionId, trimmed)
    this.scheduleSummary(sessionId)
    return this.summaryOf(this.requireSession(sessionId))
  }

  /**
   * `sessions:set-config`. Persists the given fields and pushes the header. Mode, limit and the
   * worker model are read when the next worker starts; a brain model or provider change applies
   * from the brain's next turn (a Codex model change without a restart, anything else after the
   * reply in progress ends, resuming that provider's conversation).
   */
  setConfig(sessionId: string, patch: SessionConfigPatch): SessionHeader {
    this.requireSession(sessionId)
    const orchestrator = this.orchestratorFor(sessionId, null)
    if (patch.workers?.mode === 'model' && !this.models.has(patch.workers.model)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    // A Codex brain model must be one Codex lists (so Codex is ready); a Claude one an alias or a reported id.
    if (patch.brainModel !== undefined && !this.models.has(patch.brainModel)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    const repo = this.deps.sessionsRepo
    const before = this.requireSession(sessionId)
    if (patch.mode !== undefined) repo.setMode(sessionId, patch.mode)
    if (patch.workerLimit !== undefined) {
      if (!Number.isInteger(patch.workerLimit) || patch.workerLimit < 1 || patch.workerLimit > 6) {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      repo.setWorkerLimit(sessionId, patch.workerLimit)
    }
    if (patch.workers !== undefined) repo.setWorkersPref(sessionId, patch.workers)
    if (patch.brainModel !== undefined) {
      const brain = {
        provider: patch.brainModel.provider,
        model: normalizeModel(patch.brainModel.model)
      }
      const current = this.requireSession(sessionId)
      if (brain.provider !== current.brainProvider || brain.model !== current.brainModel) {
        repo.setBrain(sessionId, brain)
        orchestrator.logEvent('brain-model', `Brain model set to ${modelLabel(brain)}`, {
          brainModel: brain.model,
          brainProvider: brain.provider
        })
      }
    }
    if (patch.autoApprove !== undefined && patch.autoApprove !== before.autoApprove) {
      repo.setAutoApprove(sessionId, patch.autoApprove)
      orchestrator.logEvent(
        'auto-approve',
        patch.autoApprove
          ? 'Auto-approve turned on: protected requests are approved, except pushes and merge requests'
          : 'Auto-approve turned off',
        { autoApprove: patch.autoApprove }
      )
      if (patch.autoApprove) orchestrator.resolveCoveredRequests()
    }
    if (patch.skipApprovals !== undefined && patch.skipApprovals !== before.skipApprovals) {
      repo.setSkipApprovals(sessionId, patch.skipApprovals)
      orchestrator.logEvent(
        'skip-approvals',
        patch.skipApprovals
          ? "Skip all approvals turned on: every permission is approved except pushes and pull or merge requests; limits lift from each agent's next turn"
          : "Skip all approvals turned off; limits return from each agent's next turn",
        { skipApprovals: patch.skipApprovals }
      )
      orchestrator.setSkipApprovals(patch.skipApprovals)
      if (patch.skipApprovals) orchestrator.resolveCoveredRequests()
    }
    orchestrator.configChanged({
      mode: before.mode,
      workerLimit: before.workerLimit,
      brainProvider: before.brainProvider,
      brainModel: before.brainModel
    })
    this.pushHeader(sessionId)
    this.scheduleSummary(sessionId)
    return this.headerOf(this.requireSession(sessionId))
  }

  /** `sessions:remove-allow-rule`: forgets one "Always allow this in this session" rule. */
  removeAllowRule(sessionId: string, ruleId: string): SessionHeader {
    this.requireSession(sessionId)
    if (!this.deps.allowRulesRepo.remove(sessionId, ruleId)) {
      throw new AppErrorException('VALIDATION_FAILED')
    }
    this.orchestratorFor(sessionId, null).logEvent(
      'allow-rule',
      'An always-allow rule was removed',
      {
        ruleId
      }
    )
    this.pushHeader(sessionId)
    return this.headerOf(this.requireSession(sessionId))
  }

  /** Older rows than `beforeId`, ascending. */
  page(sessionId: string, kind: 'messages', beforeId: number, limit: number): SessionMessage[]
  page(sessionId: string, kind: 'events', beforeId: number, limit: number): SessionEventEntry[]
  page(
    sessionId: string,
    kind: 'messages' | 'events',
    beforeId: number,
    limit: number
  ): SessionMessage[] | SessionEventEntry[] {
    this.requireSession(sessionId)
    return kind === 'messages'
      ? this.messageDtos(this.deps.messagesRepo.page(sessionId, beforeId, limit))
      : this.deps.eventsRepo.page(sessionId, beforeId, limit).map(eventDto)
  }

  /** Stops the session's processes, deletes its rows (cascade) and its `userData/sessions/<id>/` folder. */
  async delete(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.releaseSession(sessionId)
    const worktrees = this.deps.worktreesRepo.listBySession(sessionId)
    const projects = this.deps.sessionProjectsRepo.listBySession(sessionId)
    this.deps.sessionsRepo.delete(sessionId)
    await this.removeWorktrees(sessionId, worktrees, projects)
    await this.removeSessionDir(sessionId)
  }

  /** Removes a session's worker working copies (`worktree remove --force`, then the folder). Branches are kept. */
  private async removeWorktrees(
    sessionId: string,
    worktrees: readonly { path: string; projectId: string | null }[],
    projects: readonly { projectId: string | null; projectPath: string }[]
  ): Promise<void> {
    for (const tree of worktrees) {
      const project = projects.find((p) => p.projectId === tree.projectId)
      if (!project) continue
      try {
        await this.deps.worktreeGit.remove(project.projectPath, tree.path, { force: true })
      } catch (error: unknown) {
        this.deps.log.warn(`could not remove the working copy ${tree.path}`, error)
      }
    }
    if (!/^[\w-]+$/.test(sessionId)) return
    try {
      await rm(join(this.deps.getWorktreesRoot(), sessionId), { recursive: true, force: true })
    } catch (error: unknown) {
      this.deps.log.warn('could not remove the session working copies', error)
    }
    for (const project of projects) {
      await this.deps.worktreeGit.prune(project.projectPath).catch(() => undefined)
    }
  }

  /** Group delete: stops every session of the group and removes their folders; rows cascade with the group. */
  async removeForGroup(groupId: string): Promise<void> {
    for (const row of this.deps.sessionsRepo.listByGroup(groupId)) {
      await this.releaseSession(row.id)
      await this.removeWorktrees(
        row.id,
        this.deps.worktreesRepo.listBySession(row.id),
        this.deps.sessionProjectsRepo.listBySession(row.id)
      )
      await this.removeSessionDir(row.id)
    }
  }

  private async releaseSession(sessionId: string): Promise<void> {
    const timer = this.summaryTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.summaryTimers.delete(sessionId)
    this.lastSummaryKey.delete(sessionId)
    this.knownKnowledge.delete(sessionId)
    const orchestrator = this.orchestrators.get(sessionId)
    this.orchestrators.delete(sessionId)
    await orchestrator?.stop()
  }

  private async removeSessionDir(sessionId: string): Promise<void> {
    const target = resolve(this.deps.getSessionDir(sessionId))
    // Only a folder named exactly after the id, never a parent or sibling.
    if (!/^[\w-]+$/.test(sessionId)) return
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error: unknown) {
      this.deps.log.warn('could not remove the session folder', error)
    }
    try {
      await rm(resolve(this.codexBrainDir(sessionId)), { recursive: true, force: true })
    } catch (error: unknown) {
      this.deps.log.warn('could not remove the Codex brain folder', error)
    }
  }

  /** Where a Codex brain of this session runs (not created here). */
  private codexBrainDir(sessionId: string): string {
    return (
      this.deps.getCodexBrainDir?.(sessionId) ??
      join(this.deps.getSessionDir(sessionId), 'codex-brain')
    )
  }

  async sendMessage(
    sessionId: string,
    text: string,
    files?: { draftId: string; attachmentIds: readonly string[] },
    spoken?: boolean
  ): Promise<{ messageId: number; attachments: MessageAttachmentView[] }> {
    const body = text.trim()
    const ids = files?.attachmentIds ?? []
    if (body === '' && ids.length === 0) throw new AppErrorException('VALIDATION_FAILED')
    this.requireSession(sessionId)
    const orchestrator = this.orchestratorFor(sessionId, null)
    // Before anything is written or copied; the staged files stay for the renderer to retry.
    if (ids.length > 0) {
      if (startsWithSlash(body)) throw new AppErrorException('ATTACHMENTS_WITH_COMMAND')
      if (orchestrator.hasPlanAwaitingFeedback()) {
        throw new AppErrorException('ATTACHMENTS_WITH_PLAN_FEEDBACK')
      }
    }
    if (!orchestrator.isBrainRunning) await this.ensureCli()
    const now = this.now()
    const message = {
      sessionId,
      role: 'user',
      content: body,
      state: 'complete',
      planId: null,
      spoken: spoken === true,
      createdAt: now,
      updatedAt: now
    } as const
    let messageId: number
    let stored: StoredAttachment[] = []
    if (files && ids.length > 0) {
      const sender = this.deps.attachmentSender
      if (!sender) throw new AppErrorException('VALIDATION_FAILED')
      const sent = await sender.send({ sessionId, draftId: files.draftId, ids, message })
      messageId = sent.message.id
      stored = sent.attachments
    } else {
      messageId = this.deps.messagesRepo.append(message).id
    }
    this.deps.sessionsRepo.touch(sessionId, now)
    this.scheduleSummary(sessionId)
    this.deliver(sessionId, orchestrator, body, stored)
    return { messageId, attachments: stored.map(attachmentView) }
  }

  /**
   * The one place a user message goes to the brain. `attachments` are the stored files of this
   * message (absolute paths); a message with only files still reaches the brain, as the block.
   */
  private deliver(
    sessionId: string,
    orchestrator: Orchestrator,
    text: string,
    attachments: StoredAttachment[]
  ): void {
    orchestrator.send(text, attachments.length > 0 ? attachments : undefined).catch((error) => {
      // The message is already stored with its files. A plan can start waiting after the check in
      // `sendMessage`, and the orchestrator then refuses files rather than drop them: say so.
      // Log the session and the error name only; an error message may hold a path or a name.
      const name = error instanceof Error ? error.name : 'Error'
      this.deps.log.warn(
        `a message was not delivered to the brain of session ${sessionId} (${name})`
      )
      orchestrator.postSystemMessage(
        orchestrator.hasPlanAwaitingFeedback()
          ? 'Your last message was not delivered to the brain: a plan is waiting for your decision. Answer the plan, then send it again.'
          : 'Your last message was not delivered to the brain. Send it again.'
      )
    })
  }

  async stopReply(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.orchestrators.get(sessionId)?.stopReply()
  }

  /** `sessions:plan-decision`: the user's choice on a plan card. */
  decidePlan(
    sessionId: string,
    planId: string,
    decision: PlanDecision,
    models?: Record<string, ModelRef>
  ): void {
    this.requireSession(sessionId)
    const orchestrator = this.orchestratorFor(sessionId, null)
    // Each pick is a provider with one of its models.
    for (const ref of Object.values(models ?? {})) {
      if (!this.models.has(ref)) throw new AppErrorException('VALIDATION_FAILED')
    }
    orchestrator.decidePlan(planId, decision, models)
  }

  /** Token totals per agent key for worker views; undefined without a recorder. */
  private tokensOf(sessionId: string): ((agentKey: string) => TokenTotals | null) | undefined {
    return this.deps.usage?.tokensOf(sessionId)
  }

  /** `workers:get`: the worker's state plus its changed files, read from its working copies. */
  async workerDetails(workerId: string): Promise<WorkerDetails> {
    const worker = this.deps.workersRepo.get(workerId)
    if (!worker) throw new AppErrorException('VALIDATION_FAILED')
    const view = buildWorkerViews(
      worker.sessionId,
      this.deps.workersRepo,
      this.deps.worktreesRepo,
      this.deps.sessionProjectsRepo,
      this.deps.commitsRepo,
      undefined,
      undefined,
      this.tokensOf(worker.sessionId),
      this.deps.usage?.inFlightOf(worker.sessionId)
    ).find((w) => w.id === workerId)
    if (!view) throw new AppErrorException('VALIDATION_FAILED')
    const trees = view.worktrees
    const perTree = await Promise.all(
      trees.map(async (tree) => {
        try {
          const files = await this.deps.worktreeGit.changedFiles(tree.path, tree.baseSha)
          return trees.length > 1 ? files.map((f) => `${tree.projectName}/${f}`) : files
        } catch (e: unknown) {
          // The working copy may be gone (removed, or its folder deleted); show what is known.
          this.deps.log.warn(`could not list the changes in ${tree.path}`, e)
          return []
        }
      })
    )
    const projects = this.deps.sessionProjectsRepo.listBySession(view.sessionId)
    let unmergedCommits = 0
    if (view.status !== 'merged') {
      const live = this.deps.worktreesRepo
        .listByWorker(workerId)
        .filter((t) => t.removedAt === null)
      for (const tree of live) {
        const project = projects.find((p) => p.projectId !== null && p.projectId === tree.projectId)
        if (!project?.branchName) continue
        // The live HEAD: a running worker commits without Arc recording it right away.
        const head = await this.deps.worktreeGit.headSha(tree.path).catch(() => tree.headSha)
        unmergedCommits += await this.deps.worktreeGit.countUnmerged(
          project.projectPath,
          project.branchName,
          head
        )
      }
    }
    return {
      id: view.id,
      sessionId: view.sessionId,
      number: view.number,
      role: view.role,
      name:
        view.role === 'resolver'
          ? 'Conflict resolver'
          : view.command
            ? `W${view.number} \u00b7 /${commandName(view.command) ?? view.slug}`
            : `W${view.number} \u00b7 ${view.slug}`,
      status: view.status,
      model: view.model,
      ...(view.runningOn ? { runningOn: view.runningOn } : {}),
      task: view.task,
      activity: view.activity,
      lastReport: view.summary,
      failureReason: view.failureReason,
      stoppedBy: view.stoppedBy,
      changedFiles: perTree.flat(),
      worktreePaths: trees.map((t) => ({ projectName: t.projectName, path: t.path })),
      projects: trees.map((t) => t.projectName),
      hasWorkingCopy: view.hasWorkingCopy,
      unmergedCommits,
      userControl: view.userControl ?? null,
      controlReplying:
        this.orchestrators.get(view.sessionId)?.workerViews.find((w) => w.id === workerId)
          ?.controlReplying ?? false
    }
  }

  /** Pending requests that are with the user (`sessions:attention-summary`, the badge, the dialog). */
  attentionState(sessionId: string): AttentionState {
    this.requireSession(sessionId)
    const requests = this.deps.attentionRepo.listPendingEscalated(sessionId)
    return { count: requests.filter((r) => r.route === 'queue').length, requests }
  }

  /**
   * `attention:answer`. Approves or denies a permission request, or answers a question, for the user.
   * Works for a request whose agent call is gone (after a restart): the answer is stored undelivered.
   */
  answerAttention(requestId: string, answer: AttentionAnswer): void {
    const row = this.deps.attentionRepo.get(requestId)
    if (!row) throw new AppErrorException('VALIDATION_FAILED')
    this.requireSession(row.sessionId)
    this.orchestratorFor(row.sessionId, null).answerAttention(requestId, answer)
  }

  /** `workers:open-terminal`: the live tail, or the whole log file of a worker that is not running here. */
  openTerminal(workerId: string): Promise<TerminalBacklog> {
    const worker = this.deps.workersRepo.get(workerId)
    if (!worker) throw new AppErrorException('VALIDATION_FAILED')
    const orchestrator = this.orchestrators.get(worker.sessionId)
    if (orchestrator) return orchestrator.openTerminal(workerId)
    return readTerminalFile(
      join(this.deps.getSessionDir(worker.sessionId), 'workers', `${worker.id}.log`)
    )
  }

  /** `workers:stop`. A worker that is not running (already ended, or from before a restart) is left as it is. */
  async stopWorker(workerId: string): Promise<void> {
    const worker = this.deps.workersRepo.get(workerId)
    if (!worker) throw new AppErrorException('VALIDATION_FAILED')
    await this.orchestrators.get(worker.sessionId)?.stopWorker(workerId)
  }

  /** `workers:step-in`, `workers:hand-back`, `workers:send-input` and `workers:interrupt`: the worker's session must be open. */
  async stepInWorker(workerId: string): Promise<void> {
    await this.openOrchestratorOfWorker(workerId).stepInWorker(workerId)
  }

  async handBackWorker(workerId: string): Promise<void> {
    await this.openOrchestratorOfWorker(workerId).handBackWorker(workerId)
  }

  async sendWorkerInput(workerId: string, text: string): Promise<void> {
    await this.openOrchestratorOfWorker(workerId).sendWorkerInput(workerId, text)
  }

  interruptWorker(workerId: string): Promise<{ outcome: InterruptOutcome }> {
    return this.openOrchestratorOfWorker(workerId).interruptWorker(workerId)
  }

  private openOrchestratorOfWorker(workerId: string): Orchestrator {
    const worker = this.deps.workersRepo.get(workerId)
    const orchestrator = worker ? this.orchestrators.get(worker.sessionId) : undefined
    if (!orchestrator) throw new AppErrorException('VALIDATION_FAILED')
    return orchestrator
  }

  /** `workers:continue` for one worker (`VALIDATION_FAILED` with `details.reason` when it cannot be continued). */
  async continueWorker(workerId: string): Promise<void> {
    const worker = this.deps.workersRepo.get(workerId)
    if (!worker) throw new AppErrorException('VALIDATION_FAILED')
    await this.orchestratorFor(worker.sessionId, null).continueWorker(workerId)
  }

  /** `workers:continue` with `all`: every worker of the session that can be continued. */
  async continueAllWorkers(sessionId: string): Promise<void> {
    this.requireSession(sessionId)
    await this.orchestratorFor(sessionId, null).continueAllWorkers()
  }

  /** `sessions:dismiss-prompt`: Not now on the continue prompt. */
  dismissPrompt(sessionId: string, messageId: number): void {
    this.requireSession(sessionId)
    this.orchestratorFor(sessionId, null).dismissPrompt(messageId)
  }

  /** `workers:remove`. Refuses (VALIDATION_FAILED) a worker that is queued or running. */
  async removeWorker(workerId: string): Promise<void> {
    const worker = this.deps.workersRepo.get(workerId)
    if (!worker || worker.removedAt !== null) throw new AppErrorException('VALIDATION_FAILED')
    await this.orchestratorFor(worker.sessionId, null).removeWorker(workerId)
  }

  /**
   * Launch sweep: removes leftover `_merge` working copies and runs `git worktree prune` in every
   * repository sessions use (tech spec 2.7 and 2.10).
   */
  sweepWorktrees(): Promise<unknown> {
    return sweepWorktrees({
      worktreesRoot: this.deps.getWorktreesRoot(),
      repoPaths: this.deps.sessionProjectsRepo.listGitPaths(),
      worktreeGit: this.deps.worktreeGit,
      log: this.deps.log
    })
  }

  private shutdownRun: Promise<void> | undefined

  /**
   * The quit sequence (tech spec 2.10). Calls made while it runs share the one run: Stopped is written first, pending bridge calls
   * settle, agents are interrupted and killed within 8 s, then the bridge closes and `cleanup` runs.
   */
  shutdown(hooks: ShutdownHooks = {}): Promise<void> {
    this.shutdownRun ??= runShutdown({
      writeStopped: () => this.writeStoppedForQuit(),
      settleBridgeCalls: () => {
        for (const o of this.orchestrators.values()) o.settleForShutdown()
      },
      stopAgents: async () => {
        await Promise.all([...this.orchestrators.values()].map((o) => o.stop()))
        this.orchestrators.clear()
      },
      liveCount: hooks.liveCount ?? (() => 0),
      signalAll: hooks.signalAll ?? (() => undefined),
      closeBridge: hooks.closeBridge ?? (() => Promise.resolve()),
      cleanup: hooks.cleanup ?? (() => undefined),
      ...(hooks.cancelPluginOps ? { cancelPluginOps: hooks.cancelPluginOps } : {}),
      log: this.deps.log,
      ...(hooks.timings ? { timings: hooks.timings } : {})
    }).finally(() => {
      this.shutdownRun = undefined
    })
    return this.shutdownRun
  }

  /** Quit step 1, synchronous: nothing below can lose it. */
  private writeStoppedForQuit(): void {
    this.closed = true
    for (const timer of this.summaryTimers.values()) clearTimeout(timer)
    this.summaryTimers.clear()
    const now = this.now()
    // Control first: a worker the user is in control of is paused, then skipped by the stop below.
    this.deps.workersRepo.pauseAllActiveControl(now)
    const rows = this.deps.workersRepo.stopInterrupted(now, 'quit')
    for (const row of rows) {
      this.deps.eventsRepo.append({
        sessionId: row.sessionId,
        at: now,
        kind: 'worker-stopped',
        text: `${workerLabel(row)} stopped when Arc quit`,
        workerId: row.id,
        dataJson: null
      })
    }
    this.deps.messagesRepo.recoverStreaming(now)
  }

  private requireSession(sessionId: string): SessionRow {
    const row = this.deps.sessionsRepo.getById(sessionId)
    if (!row) throw new AppErrorException('SESSION_NOT_FOUND')
    return row
  }

  /** Checks Claude Code lazily before the first spawn: re-checks once when it was not ok. */
  private async ensureCli(): Promise<void> {
    if (this.deps.getCliStatus()?.state === 'ok') return
    const status = await this.deps.recheckCli()
    if (status.state !== 'ok') throw new AppErrorException('CLI_UNAVAILABLE')
  }

  private orchestratorFor(sessionId: string, firstRequest: string | null): Orchestrator {
    const existing = this.orchestrators.get(sessionId)
    if (existing) return existing
    const row = this.requireSession(sessionId)
    let titleRequest = firstRequest
    if (titleRequest === null && row.name === PLACEHOLDER_SESSION_NAME) {
      titleRequest =
        this.deps.messagesRepo
          .latest(sessionId, SNAPSHOT_MESSAGES)
          .find((m) => m.role === 'user' && m.content !== '')?.content ?? null
    }
    const orchestrator = new Orchestrator({
      sessionId,
      registry: this.deps.registry,
      models: this.models,
      providers: this.deps.providers,
      sessionsRepo: this.deps.sessionsRepo,
      brainThreadsRepo: this.deps.brainThreadsRepo,
      messagesRepo: this.deps.messagesRepo,
      eventsRepo: this.deps.eventsRepo,
      resources: {
        plansRepo: this.deps.plansRepo,
        workersRepo: this.deps.workersRepo,
        worktreesRepo: this.deps.worktreesRepo,
        heldMessagesRepo: this.deps.heldMessagesRepo,
        commitsRepo: this.deps.commitsRepo,
        sessionProjectsRepo: this.deps.sessionProjectsRepo,
        worktreeGit: this.deps.worktreeGit,
        attentionRepo: this.deps.attentionRepo,
        allowRulesRepo: this.deps.allowRulesRepo,
        mergesRepo: this.deps.mergesRepo,
        mergeGit: this.deps.mergeGit,
        reviewService: this.deps.reviewService,
        mergeQueue: this.mergeQueue,
        bridge: this.deps.bridge,
        getPluginViewDir: this.deps.getPluginViewDir,
        personal: this.deps.personal,
        getWorktreesRoot: this.deps.getWorktreesRoot,
        getKnowledgeDir: () => this.deps.getKnowledgeRoot(row.groupId),
        getTerminalDir: () => join(this.deps.getSessionDir(sessionId), 'workers'),
        getSessionDir: () => this.deps.getSessionDir(sessionId),
        attachmentsRepo: this.deps.messageAttachmentsRepo,
        groupName: () => this.deps.groupsRepo.getById(row.groupId)?.name ?? 'group',
        branchesReady: () => this.branchStarts.get(sessionId) ?? Promise.resolve(),
        ensureBranches: (projectIds, workerId) =>
          this.branchOnDemand.ensure(sessionId, projectIds, workerId),
        branchWaits: (projectIds) => this.branchOnDemand.waitingOn(sessionId, projectIds),
        cancelBranchOrphans: () => this.cancelBranchOrphans(sessionId),
        autoMerge: this.deps.autoMergeDone ?? true
      },
      newId: this.newId,
      getLaunch: (commands, forced, limited) =>
        this.buildLaunch(sessionId, commands, forced, limited),
      titleRequest,
      emit: this.deps.emit,
      now: this.now,
      log: this.deps.log,
      onSignedOut: this.deps.onSignedOut,
      onChange: () => this.scheduleSummary(sessionId),
      onNamed: (name) => void this.startBranches(sessionId, name),
      onAttentionChanged: (state) => this.deps.onAttentionChanged?.(sessionId, state),
      onHeaderChanged: () => this.pushHeader(sessionId),
      usage: this.deps.usage,
      planUsage: this.deps.planUsage,
      knowledgeSuggestions: this.deps.knowledgeSuggestions,
      suggestKnowledge: this.deps.suggestKnowledge,
      ...(this.deps.codexCommands ? { codexCommands: this.deps.codexCommands } : {}),
      ...(this.deps.cursorCommands ? { cursorCommands: this.deps.cursorCommands } : {}),
      ...(this.deps.commands
        ? { listCommands: (refresh: boolean) => this.listCommands(sessionId, refresh) }
        : {}),
      ...(this.deps.timings ? { timings: this.deps.timings } : {})
    })
    this.orchestrators.set(sessionId, orchestrator)
    this.knownKnowledge.set(sessionId, this.deps.getKnowledgeRoot(row.groupId))
    void this.warnRepoSettings(sessionId)
    return orchestrator
  }

  /** Where the brain runs: its first folder, or a folder of its own when that one is gone. */
  private brainCwdOf(session: SessionRow): string {
    const exists = this.deps.directoryExists ?? isDirectory
    let cwd = session.brainCwd ?? this.deps.getKnowledgeRoot(session.groupId)
    if (!exists(cwd)) {
      cwd = join(this.deps.getSessionDir(session.id), 'brain')
      mkdirSync(cwd, { recursive: true })
    }
    return cwd
  }

  private buildLaunch(
    sessionId: string,
    commands?: readonly CommandInfo[] | null,
    forceUnavailable?: ProviderUnavailableReason,
    limited?: ReadonlySet<ProviderId>
  ): BrainLaunch {
    const session = this.requireSession(sessionId)
    const group = this.deps.groupsRepo.getById(session.groupId)
    if (!group) throw new AppErrorException('INTERNAL')
    const exists = this.deps.directoryExists ?? isDirectory
    const projects = this.deps.projectsRepo
      .listByGroup(session.groupId)
      .filter((p) => exists(p.path))
      .map((p) => ({ name: p.displayName, path: p.path }))
    const knowledgePath = this.deps.getKnowledgeRoot(session.groupId)
    const status = this.deps.providers?.get() ?? {}
    const brain = effectiveBrain(session, status, forceUnavailable, {
      limited,
      defaultFor: (p) => this.models.defaultFor(p)
    })
    // The Claude brain always restarts where it first started, so its conversation can be resumed;
    // only when that folder is gone does it move to a stable folder of its own. The Codex brain runs
    // in an Arc-owned folder (it holds the rules file) and reads the knowledge folder from there;
    // Cursor's brain will use the same folder.
    const cwd =
      brain.provider === 'claude' ? this.brainCwdOf(session) : this.codexBrainDirOf(sessionId)
    const providers = {
      brain: { provider: brain.provider, model: brain.model },
      workers: workersPrefOf(session),
      models: this.models.all(),
      status,
      claudePlanPercent: this.claudePlanPercent()
    }
    const workersEnabled = this.deps.bridge !== undefined
    return {
      cwd,
      addDirs: [
        ...projects.map((p) => p.path),
        ...(knowledgePath === cwd || !exists(knowledgePath) ? [] : [knowledgePath]),
        // Always present, so a message with attachments never changes the launch (`launchKey`).
        this.attachmentsDirOf(sessionId)
      ],
      instructions: buildBrainPrompt({
        groupName: group.name,
        knowledgePath,
        workingDir: cwd,
        projects,
        workersEnabled,
        mode: session.mode,
        workerLimit: session.workerLimit,
        brainProvider: brain.provider,
        providers,
        suggestOnOwn: this.deps.suggestKnowledge?.() ?? true,
        ...(commands !== undefined ? { commands } : {})
      }),
      provider: brain.provider,
      brainModel: brain.model,
      ...(brain.unavailable !== undefined && brain.requested !== undefined
        ? { unavailable: brain.unavailable, requestedProvider: brain.requested }
        : {}),
      resumeThreadId: this.deps.brainThreadsRepo.get(session.id, brain.provider) ?? null,
      ...(workersEnabled ? { providersSection: providersSection(providers) } : {})
    }
  }

  /** Claude's fullest current plan limit now, read each time a brain prompt is built. */
  private claudePlanPercent(): number | undefined {
    try {
      const plans = this.deps.planUsage?.meters?.()
      return plans === undefined ? undefined : fullestPlanPercent(plans, 'claude')
    } catch (error: unknown) {
      this.deps.log.warn('could not read the Claude plan meter for the brain prompt', error)
      return undefined
    }
  }

  /** `userData/sessions/<id>/attachments`, made here when a session from before attachments lacks it. */
  private attachmentsDirOf(sessionId: string): string {
    const dir = sentAttachmentsRoot(this.deps.getSessionDir(sessionId))
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private codexBrainDirOf(sessionId: string): string {
    const dir = this.codexBrainDir(sessionId)
    mkdirSync(dir, { recursive: true })
    return dir
  }
}
