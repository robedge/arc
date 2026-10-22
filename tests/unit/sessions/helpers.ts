import { join } from 'node:path'
import { vi } from 'vitest'
import type {
  AgentAdapter,
  AgentHandle,
  ClaudeStartRequest,
  CodexStartRequest,
  CursorStartRequest,
  InterruptOutcome,
  McpServerTools,
  StartOptions
} from '../../../src/main/agents/agent-adapter'
import { CLAUDE_CAPABILITIES } from '../../../src/main/agents/claude-adapter'
import { AdapterRegistry } from '../../../src/main/agents/provider-registry'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import type { CodexInput } from '../../../src/main/agents/codex/codex-types'
import { EventQueue } from '../../../src/main/agents/event-queue'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { EventsRepo } from '../../../src/main/db/repositories/events-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { ReviewMarksRepo } from '../../../src/main/db/repositories/review-marks-repo'
import { ReviewNotesRepo } from '../../../src/main/db/repositories/review-notes-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { createGit } from '../../../src/main/git/git'
import { AllowRulesRepo } from '../../../src/main/db/repositories/allow-rules-repo'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import { CommitsRepo } from '../../../src/main/db/repositories/commits-repo'
import { PlansRepo } from '../../../src/main/db/repositories/plans-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import { HeldMessagesRepo } from '../../../src/main/db/repositories/held-messages-repo'
import { WorktreesRepo } from '../../../src/main/db/repositories/worktrees-repo'
import { createSessionGit } from '../../../src/main/git/session-git'
import { createWorktreeGit } from '../../../src/main/git/worktrees'
import { createMergeGit } from '../../../src/main/git/merge'
import { createAttribution } from '../../../src/main/review/attribution'
import { createPushGit } from '../../../src/main/git/push'
import { PushService } from '../../../src/main/review/push-service'
import { createReviewGit } from '../../../src/main/git/review-git'
import { NotesService } from '../../../src/main/review/notes-service'
import { ReviewService } from '../../../src/main/review/review-service'
import { UndoService } from '../../../src/main/review/undo-service'
import type { UndoServiceDeps } from '../../../src/main/review/undo-service'
import { MergeQueue } from '../../../src/main/git/merge-queue'
import { MergesRepo } from '../../../src/main/db/repositories/merges-repo'
import { gitFixtureEnv } from '../../helpers/git-fixtures'
import { AppSettingsRepo } from '../../../src/main/db/repositories/app-settings-repo'
import { BrainThreadsRepo } from '../../../src/main/db/repositories/brain-threads-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { SessionService } from '../../../src/main/sessions/session-service'
import type { SessionServiceDeps } from '../../../src/main/sessions/session-service'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import type { CliStatus } from '../../../src/shared/types/session'
import type { ProviderId } from '../../../src/shared/types/provider'
import { realMigrations } from '../db/helpers'

export const okStatus: CliStatus = { state: 'ok', version: '2.1.302', message: '' }

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An event a test plays: the fields the provider-neutral union added are optional and filled in. */
type Loosen<E> = E extends { type: 'turn-result' }
  ? Omit<E, 'status'> & { status?: 'completed' | 'interrupted' | 'failed' }
  : E extends { type: 'session' | 'rate-limit' }
    ? Omit<E, 'provider'> & { provider?: 'claude' | 'codex' }
    : E
type FakeEvent = Loosen<DistributiveOmit<AgentEvent, 'agentId' | 'ts'>>

export class FakeHandle implements AgentHandle {
  readonly capabilities = CLAUDE_CAPABILITIES
  readonly pid = undefined
  readonly queue = new EventQueue<AgentEvent>()
  readonly events: AsyncIterable<AgentEvent> = this.queue
  readonly sent: string[] = []
  interrupts = 0
  /** What `interrupt()` reports; `killed` plays an interrupt the process did not survive. */
  interruptOutcome: InterruptOutcome = 'acked'
  stopped = false
  /** A test sets it to false to play a process that is gone when the first message is written. */
  sendsOk = true
  /** The models passed to `setModel`; only a Codex handle has it, as the real one does. */
  readonly models: string[] = []
  setModel?: (model: string) => void
  /** The structured inputs (skills) passed to `sendInput`; only a Codex handle has it, as the real one does. */
  readonly inputs: CodexInput[][] = []
  sendInput?: (input: CodexInput[]) => Promise<boolean>
  /** A test sets it to play a Codex handle that holds sends behind the running turn. */
  discardQueuedSends?: () => string[]
  /** A test sets it to play an agent that reports its MCP servers (Claude `mcp_status`, Codex `mcpServerStatus/list`). */
  mcpTools?: () => Promise<McpServerTools[]>

  constructor(
    readonly agentId: string,
    readonly provider: ProviderId = 'claude'
  ) {
    if (provider === 'cursor') this.setModel = (model) => void this.models.push(model)
    if (provider === 'codex') {
      this.setModel = (model) => void this.models.push(model)
      this.sendInput = (input) => {
        this.inputs.push(input)
        return Promise.resolve(true)
      }
    }
  }

  emit(event: FakeEvent): void {
    const filled: Record<string, unknown> = { agentId: this.agentId, ts: 0, ...event }
    if (event.type === 'session' || event.type === 'rate-limit')
      filled['provider'] ??= this.provider
    if (event.type === 'turn-result') {
      filled['status'] ??= event.interrupted ? 'interrupted' : event.ok ? 'completed' : 'failed'
    }
    this.queue.push(filled as unknown as AgentEvent)
  }

  send(text: string): Promise<boolean> {
    this.sent.push(text)
    return Promise.resolve(this.sendsOk)
  }

  interrupt(): Promise<InterruptOutcome> {
    this.interrupts += 1
    if (this.interruptOutcome !== 'killed') {
      this.emit({ type: 'turn-result', ok: false, interrupted: true, durationMs: 1 })
    }
    return Promise.resolve(this.interruptOutcome)
  }

  stop(): Promise<void> {
    this.stopped = true
    this.emit({ type: 'exit', code: 0, signal: null, expected: true, stderrTail: '' })
    this.queue.close()
    return Promise.resolve()
  }

  delta(text: string, messageId = 'm1'): void {
    this.emit({ type: 'text-delta', messageId, text })
  }
}

/** The registry a service takes, over one Claude adapter (and a Codex one when a test gives it). */
export function claudeRegistry(
  adapter: AgentAdapter,
  codex?: AgentAdapter,
  cursor?: AgentAdapter
): AdapterRegistry {
  return new AdapterRegistry({
    claude: adapter,
    ...(codex ? { codex } : {}),
    ...(cursor ? { cursor } : {})
  })
}

/** Plays the Cursor adapter: records each start and hands back a fake handle whose events the test emits. */
export class FakeCursorAdapter implements AgentAdapter {
  readonly provider = 'cursor' as const
  readonly handles: FakeHandle[] = []
  readonly starts: CursorStartRequest[] = []
  readonly resumes: CursorStartRequest[] = []
  /** When set, starts and resumes reject with it, as a handshake that finds Cursor unusable does. */
  failWith: Error | undefined
  /** When set, resumes alone reject with it (a session Cursor no longer has, -32602 "not found"). */
  failResumeWith: Error | undefined
  /** When false, the handles it starts report their first send as not written. */
  sendsOk = true

  start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'cursor')
      throw new Error('the fake Cursor adapter only starts Cursor agents')
    if (this.failWith) return Promise.reject(this.failWith)
    this.starts.push(options)
    const handle = new FakeHandle(options.agentId, 'cursor')
    handle.sendsOk = this.sendsOk
    this.handles.push(handle)
    return Promise.resolve(handle)
  }

  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle> {
    if (this.failResumeWith) return Promise.reject(this.failResumeWith)
    if (options.provider === 'cursor') this.resumes.push(options)
    return this.start(options)
  }
}

/** Plays the Codex adapter: records each start and hands back a fake handle whose events the test emits. */
export class FakeCodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const
  readonly handles: FakeHandle[] = []
  readonly starts: CodexStartRequest[] = []
  readonly resumes: CodexStartRequest[] = []
  /** When set, starts and resumes reject with it, as a handshake that finds Codex unusable does. */
  failWith: Error | undefined
  /** When set, resumes alone reject with it (a thread Codex no longer has). */
  failResumeWith: Error | undefined

  start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'codex')
      throw new Error('the fake Codex adapter only starts Codex agents')
    if (this.failWith) return Promise.reject(this.failWith)
    this.starts.push(options)
    const handle = new FakeHandle(options.agentId, 'codex')
    this.handles.push(handle)
    return Promise.resolve(handle)
  }

  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle> {
    if (this.failResumeWith) return Promise.reject(this.failResumeWith)
    if (options.provider === 'codex') this.resumes.push(options)
    return this.start(options)
  }
}

export class FakeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const
  readonly handles: FakeHandle[] = []
  readonly starts: ClaudeStartRequest[] = []

  start(options: StartOptions): Promise<AgentHandle> {
    if (options.provider !== 'claude') throw new Error('the fake adapter only starts Claude agents')
    this.starts.push(options)
    const handle = new FakeHandle(options.agentId)
    this.handles.push(handle)
    return Promise.resolve(handle)
  }

  resume(options: StartOptions & { resume: { threadId: string } }): Promise<AgentHandle> {
    return this.start(options)
  }

  get last(): FakeHandle {
    const handle = this.handles[this.handles.length - 1]
    if (!handle) throw new Error('the brain was not started')
    return handle
  }
}

export type Pushed = {
  [E in keyof IpcEvents]: { event: E; payload: IpcEvents[E] }
}[keyof IpcEvents]

export interface Rig {
  work: string
  opened: OpenedDatabase
  groupId: string
  adapter: FakeAdapter
  service: SessionService
  deps: SessionServiceDeps
  /** The dependencies `deps.undoService` was built from. */
  undoDeps: UndoServiceDeps
  sessionsRepo: SessionsRepo
  /** The Settings defaults new sessions copy. */
  appSettingsRepo: AppSettingsRepo
  brainThreadsRepo: BrainThreadsRepo
  messagesRepo: MessagesRepo
  eventsRepo: EventsRepo
  pushed: Pushed[]
  clock: { now: number }
  signedOut: ReturnType<typeof vi.fn>
  recheck: ReturnType<typeof vi.fn>
  of<E extends keyof IpcEvents>(event: E): IpcEvents[E][]
  close(): void
}

/** A real temp database with one group and one project, a fake adapter and a controllable clock. */
export async function makeRig(
  work: string,
  overrides: Partial<SessionServiceDeps> & {
    cliStatus?: CliStatus | undefined
    /** A single adapter, wrapped in the registry the service takes. */
    adapter?: AgentAdapter
    /** Registered next to the Claude adapter, so a worker can run on Codex. */
    codexAdapter?: AgentAdapter
    /** Registered next to the others, so a worker can run on Cursor. */
    cursorAdapter?: AgentAdapter
  } = {}
): Promise<Rig> {
  const opened = openDatabase({ dbPath: join(work, 'arc.db'), migrationsFolder: realMigrations })
  const group = await new GroupService({
    db: opened.db,
    groupsRepo: new GroupsRepo(opened.db),
    appDataDir: join(work, 'userData')
  }).create('Alpha')
  const projectsRepo = new ProjectsRepo(opened.db)
  projectsRepo.insert({
    id: 'p1',
    path: join(work, 'repo-a'),
    displayName: 'repo-a',
    isGit: false,
    createdAt: 1
  })
  projectsRepo.addMembership(group.id, 'p1', 0, 1)
  const adapter = new FakeAdapter()
  const clock = { now: 1_000_000 }
  const pushed: Pushed[] = []
  const signedOut = vi.fn()
  const recheck = vi.fn(() => Promise.resolve(okStatus))
  let counter = 0
  const sessionsRepo = new SessionsRepo(opened.db)
  const brainThreadsRepo = new BrainThreadsRepo(opened.db)
  const appSettingsRepo = new AppSettingsRepo(opened.db)
  const messagesRepo = new MessagesRepo(opened.db)
  const eventsRepo = new EventsRepo(opened.db)
  const git = createGit({ env: gitFixtureEnv })
  const sessionGit = createSessionGit(git)
  const mergeGit = createMergeGit(git, sessionGit)
  const sessionProjectsRepo = new SessionProjectsRepo(opened.db)
  const mergeQueue = new MergeQueue()
  const pushGit = createPushGit({ env: gitFixtureEnv })
  const reviewService = new ReviewService({
    sessionProjectsRepo,
    mergeGit,
    reviewGit: createReviewGit(git),
    pushGit,
    attribution: createAttribution({
      git,
      workersRepo: new WorkersRepo(opened.db),
      commitsRepo: new CommitsRepo(opened.db),
      mergesRepo: new MergesRepo(opened.db)
    }),
    marksRepo: new ReviewMarksRepo(opened.db),
    log: { warn: vi.fn() }
  })
  const undoDeps: UndoServiceDeps = {
    reviewService,
    workersRepo: new WorkersRepo(opened.db),
    worktreesRepo: new WorktreesRepo(opened.db),
    worktreeGit: createWorktreeGit(git),
    mergeGit,
    git,
    queue: mergeQueue,
    marksRepo: new ReviewMarksRepo(opened.db),
    getWorktreesRoot: () => join(work, 'userData', 'worktrees'),
    log: { warn: vi.fn() }
  }
  const undoService = new UndoService(undoDeps)
  const deps: SessionServiceDeps = {
    plansRepo: new PlansRepo(opened.db),
    workersRepo: new WorkersRepo(opened.db),
    worktreesRepo: new WorktreesRepo(opened.db),
    heldMessagesRepo: new HeldMessagesRepo(opened.db),
    commitsRepo: new CommitsRepo(opened.db),
    attentionRepo: new AttentionRepo(opened.db),
    allowRulesRepo: new AllowRulesRepo(opened.db),
    worktreeGit: createWorktreeGit(git),
    mergesRepo: new MergesRepo(opened.db),
    mergeGit,
    reviewService,
    notesService: new NotesService({
      notesRepo: new ReviewNotesRepo(opened.db),
      sessionProjectsRepo,
      reviewService,
      log: { warn: vi.fn() }
    }),
    undoService,
    pushService: new PushService({
      sessionProjectsRepo,
      mergeGit,
      pushGit,
      log: { warn: vi.fn() }
    }),
    mergeQueue,
    getWorktreesRoot: () => join(work, 'userData', 'worktrees'),
    sessionsRepo,
    appSettings: appSettingsRepo,
    brainThreadsRepo,
    messagesRepo,
    eventsRepo,
    groupsRepo: new GroupsRepo(opened.db),
    projectsRepo,
    sessionProjectsRepo,
    sessionGit,
    getKnowledgeRoot: (groupId) => join(work, 'userData', 'groups', groupId, 'knowledge'),
    getSessionDir: (sessionId) => join(work, 'userData', 'sessions', sessionId),
    getCodexBrainDir: (sessionId) => join(work, 'userData', 'codex-brain', sessionId),
    registry: claudeRegistry(
      overrides.adapter ?? adapter,
      overrides.codexAdapter,
      overrides.cursorAdapter
    ),
    getCliStatus: () => ('cliStatus' in overrides ? overrides.cliStatus : okStatus),
    recheckCli: recheck,
    onSignedOut: signedOut,
    emit: (event, payload) => {
      pushed.push({ event, payload } as Pushed)
    },
    now: () => clock.now,
    newId: () => `S${(counter += 1)}`,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    directoryExists: () => true,
    ...overrides
  }
  const service = new SessionService(deps)
  return {
    work,
    opened,
    groupId: group.id,
    adapter,
    service,
    deps,
    undoDeps,
    sessionsRepo,
    appSettingsRepo,
    brainThreadsRepo,
    messagesRepo,
    eventsRepo,
    pushed,
    clock,
    signedOut,
    recheck,
    of: <E extends keyof IpcEvents>(event: E) =>
      pushed.filter((p) => p.event === event).map((p) => p.payload as IpcEvents[E]),
    close: () => opened.sqlite.close()
  }
}
