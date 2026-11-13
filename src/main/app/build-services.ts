import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Notification, shell } from 'electron'
import type { Db } from '../db/client'
import { GroupService } from '../groups/group-service'
import { ProjectService } from '../groups/project-service'
import { ProjectsRepo } from '../db/repositories/projects-repo'
import { GroupsRepo } from '../db/repositories/groups-repo'
import { KnowledgeStorageRepo } from '../db/repositories/knowledge-storage-repo'
import { SectionsRepo } from '../db/repositories/sections-repo'
import { createKnowledgeRootResolver } from '../knowledge/knowledge-root'
import { MetaStore } from '../knowledge/meta-store'
import { KnowledgeIndex } from '../knowledge/knowledge-index'
import { KnowledgeService } from '../knowledge/knowledge-service'
import { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import { KnowledgeSuggestionService } from '../knowledge/knowledge-suggestion-service'
import { KnowledgeSuggestionsRepo } from '../db/repositories/knowledge-suggestions-repo'
import { SectionService } from '../knowledge/section-service'
import { KnowledgeWatcher } from '../knowledge/knowledge-watcher'
import { KnowledgeStorageService } from '../knowledge/knowledge-storage-service'
import { createRevealResolver } from '../knowledge/reveal-path'
import { AvailabilityService } from '../knowledge/availability-service'
import { clearStagingRoot } from '../attachments/attachment-cleanup'
import { AttachmentSender } from '../attachments/attachment-send'
import { AttachmentService } from '../attachments/attachment-service'
import { makeNativeThumbnail } from '../attachments/attachment-thumbnail'
import { CliResolver } from '../agents/cli-resolver'
import { ProviderStatusService } from '../providers/provider-status-service'
import { CommandCatalogue, CommandProbe } from '../agents/command-probe'
import { BypassDetector } from '../personal/bypass-detector'
import { LoadCatalogue } from '../personal/load-catalogue'
import { createLoadSelection } from '../personal/load-selection'
import { McpToolCatalogue } from '../personal/mcp-tool-catalogue'
import { PersonalConfigService } from '../personal/personal-config'
import { createClaudePluginLister, PluginViewService } from '../plugins/plugin-view'
import { PluginService, RepoSettingsWarner } from '../plugins/plugin-service'
import { ClaudeAdapter } from '../agents/claude/claude-adapter'
import { CodexAdapter } from '../agents/codex/codex-adapter'
import { CodexCommands } from '../agents/codex/codex-commands'
import { CursorCommands } from '../agents/cursor/cursor-commands'
import { CodexProbe } from '../agents/codex/codex-probe'
import { CursorAdapter } from '../agents/cursor/cursor-adapter'
import { CursorProbe } from '../agents/cursor/cursor-probe'
import { ClaudeModelProbe } from '../models/claude-models'
import { ModelRegistry } from '../models/model-registry'
import { LatestVersions } from '../providers/provider-versions'
import { AppSettingsRepo } from '../db/repositories/app-settings-repo'
import { AgentSetupRepo } from '../db/repositories/agent-setup-repo'
import { UsageRepo } from '../db/repositories/usage-repo'
import { UsageRecorder } from '../usage/usage-recorder'
import { SuggestionService } from '../usage/suggestion-service'
import { UsageSuggestionsRepo } from '../db/repositories/usage-suggestions-repo'
import { FileReadsRepo } from '../db/repositories/file-reads-repo'
import { PlanNotices } from '../usage/plan-notices'
import { PlanNoticesRepo } from '../db/repositories/plan-notices-repo'
import { PlanUsageService } from '../usage/plan-usage-service'
import { CodexRateLimitReader } from '../usage/codex-rate-limit-reader'
import { CursorPlanReader } from '../usage/cursor-plan-reader'
import { ClaudePlanProbe, planProbeTarget } from '../usage/claude-plan-probe'
import { PlanLimitsRepo } from '../db/repositories/plan-limits-repo'
import { AdapterRegistry } from '../agents/provider-registry'
import { PidLedger } from '../agents/pid-ledger'
import { ProcessSupervisor } from '../agents/process-supervisor'
import { EventsRepo } from '../db/repositories/events-repo'
import { MessagesRepo } from '../db/repositories/messages-repo'
import { BranchQuestionsRepo } from '../db/repositories/branch-questions-repo'
import { MessageAttachmentsRepo } from '../db/repositories/message-attachments-repo'
import { AllowRulesRepo } from '../db/repositories/allow-rules-repo'
import { AttentionRepo } from '../db/repositories/attention-repo'
import { BrainThreadsRepo } from '../db/repositories/brain-threads-repo'
import { SessionsRepo } from '../db/repositories/sessions-repo'
import { ReviewMarksRepo } from '../db/repositories/review-marks-repo'
import { ReviewNotesRepo } from '../db/repositories/review-notes-repo'
import { SessionProjectsRepo } from '../db/repositories/session-projects-repo'
import { BridgeServer } from '../bridge/bridge-server'
import { CommitsRepo } from '../db/repositories/commits-repo'
import { PlansRepo } from '../db/repositories/plans-repo'
import { WorkersRepo } from '../db/repositories/workers-repo'
import { HeldMessagesRepo } from '../db/repositories/held-messages-repo'
import { WorktreesRepo } from '../db/repositories/worktrees-repo'
import { createGit } from '../git/git'
import { createWorktreeGit } from '../git/worktrees'
import { MergeQueue } from '../git/merge-queue'
import { createMergeGit } from '../git/merge'
import { createReviewGit } from '../git/review-git'
import { createAttribution } from '../review/attribution'
import { NotesService } from '../review/notes-service'
import { ReviewService } from '../review/review-service'
import { UndoService } from '../review/undo-service'
import { PushService } from '../review/push-service'
import { createPushGit } from '../git/push'
import { MergesRepo } from '../db/repositories/merges-repo'
import { createSessionGit } from '../git/session-git'
import { AttentionService } from '../sessions/attention-service'
import { NotificationService } from '../sessions/notification-service'
import { SessionService } from '../sessions/session-service'
import { emit } from '../ipc/register'
import { cliLog, knowledgeLog, sessionsLog } from '../logging'
import { createShellService } from '../platform/shell-service'
import type { Dialogs } from '../platform/dialogs'
import { getMainWindow } from './main-window'
import type { AppServices } from './app-services'
import { LateRef } from './late-ref'
import { ProviderChecks } from './provider-checks'

/** Where the supervisor records the agent processes it started, so a later launch can sweep orphans. */
export function pidLedgerPath(): string {
  return join(app.getPath('userData'), 'run', 'pids.json')
}

export interface BuildServicesDeps {
  db: Db
  dialogs: Dialogs
  /** Opens the main window when none exists (a notification was clicked after it was closed). */
  createWindow: () => BrowserWindow
}

/** Built once and shared by the platform pieces every domain reads from. */
interface CoreServices {
  db: Db
  dialogs: Dialogs
  resolver: CliResolver
  supervisor: ProcessSupervisor
  appSettings: AppSettingsRepo
}

function buildProviderServices(core: CoreServices, planUsage: LateRef<PlanUsageService>) {
  const { resolver, supervisor, appSettings } = core
  const providerStatus = new ProviderStatusService({
    checker: resolver,
    publish: (map) => {
      emit('providers:changed', map)
      // A provider becoming set up (or not) adds or removes its meter.
      planUsage.get().refreshMeters()
    },
    latest: new LatestVersions({
      isPackaged: app.isPackaged,
      cachePath: join(app.getPath('userData'), 'provider-cache.json'),
      log: { debug: (message, ...rest) => cliLog.debug(message, ...rest) },
      sources: { cursor: () => resolver.cursorLatestVersion() }
    }),
    locate: (provider) => resolver.locateBinary(provider),
    dismissals: {
      get: (provider) => appSettings.getDismissedUpdate(provider),
      set: (provider, version) => appSettings.setDismissedUpdate(provider, version, Date.now())
    },
    // Coarse: any live agent process counts, whichever provider it runs on.
    hasRunningAgents: () => supervisor.liveCount > 0,
    log: cliLog
  })
  const codexProbe = new CodexProbe({
    supervisor,
    binary: resolver.codexBinary(),
    resolvePath: () => resolver.resolvePath(),
    clientVersion: app.getVersion()
  })
  const codexCommands = new CodexCommands({
    skills: codexProbe,
    status: () => providerStatus.get(),
    log: sessionsLog
  })
  const cursorProbe = new CursorProbe({
    supervisor,
    binary: () => resolver.cursorBinary(),
    resolvePath: () => resolver.resolvePath(),
    dir: join(app.getPath('userData'), 'cursor-probe')
  })
  const cursorCommands = new CursorCommands({
    probe: cursorProbe,
    status: () => providerStatus.get()
  })
  const models = new ModelRegistry({
    claude: new ClaudeModelProbe({
      probe: new CommandProbe({
        supervisor,
        binary: resolver.claudeBinary(),
        resolvePath: () => resolver.resolvePath()
      }),
      dir: join(app.getPath('userData'), 'claude-probe')
    }),
    codex: codexProbe,
    cursor: cursorProbe,
    status: () => providerStatus.get(),
    cachePath: join(app.getPath('userData'), 'provider-cache.json'),
    log: sessionsLog
  })
  return { providerStatus, codexProbe, codexCommands, cursorCommands, models }
}
type ProviderServices = ReturnType<typeof buildProviderServices>

function buildKnowledgeServices(core: CoreServices) {
  const { db, dialogs } = core
  const projectsRepo = new ProjectsRepo(db)
  const groupsRepo = new GroupsRepo(db)
  // Restarting the watcher either closes it cleanly (root gone: start() finds no folder and
  // keeps no handle) or re-creates it and rescans (root back). The watcher needs the availability
  // service for `onRootGone` and the service needs the watcher here: the one cycle in this domain.
  const watcherRef = new LateRef<KnowledgeWatcher>('the knowledge watcher')
  const availability = new AvailabilityService({
    projectsRepo,
    listGroupIds: () => groupsRepo.list().map((g) => g.id),
    getLinkedRoot: (groupId) => {
      const row = new KnowledgeStorageRepo(db).get(groupId)
      return row?.mode === 'linked' ? row.linkedPath : null
    },
    onKnowledgeRootChange: async (groupId) => {
      const watcher = watcherRef.get()
      if (watcher.watchedGroupId === groupId) await watcher.start(groupId)
    },
    emit
  })
  const sectionsRepo = new SectionsRepo(db)
  const itemsRepo = new KnowledgeItemsRepo(db)
  const metaStore = new MetaStore({ log: knowledgeLog })
  const getKnowledgeRoot = createKnowledgeRootResolver({
    storageRepo: new KnowledgeStorageRepo(db),
    appDataDir: app.getPath('userData')
  })
  const knowledgeIndex = new KnowledgeIndex({
    sectionsRepo,
    itemsRepo,
    metaStore,
    getKnowledgeRoot,
    log: knowledgeLog
  })
  const sectionService = new SectionService({
    sectionsRepo,
    getKnowledgeRoot,
    metaStore,
    log: knowledgeLog
  })
  const knowledgeWatcher = new KnowledgeWatcher({
    getKnowledgeRoot,
    index: knowledgeIndex,
    sectionsRepo,
    itemsRepo,
    adoptFolders: (groupId) => sectionService.adoptFolders(groupId),
    emit,
    // Root renamed or deleted while open: re-check availability now rather than at the next tick.
    onRootGone: (groupId) => void availability.checkGroup(groupId),
    log: knowledgeLog
  })
  watcherRef.bind(knowledgeWatcher)
  const storageService = new KnowledgeStorageService({
    storageRepo: new KnowledgeStorageRepo(db),
    projectsRepo,
    sectionsRepo,
    metaStore,
    dialogs,
    groupsRepo,
    watcher: knowledgeWatcher,
    index: knowledgeIndex,
    adoptFolders: (groupId) => sectionService.adoptFolders(groupId),
    listGroupIds: () => groupsRepo.list().map((g) => g.id),
    appDataDir: app.getPath('userData'),
    emit,
    log: knowledgeLog
  })
  const knowledgeService = new KnowledgeService({
    sectionsRepo,
    itemsRepo,
    index: knowledgeIndex,
    metaStore,
    getKnowledgeRoot,
    log: knowledgeLog
  })
  // Events are written through the session service, which is built later and reads the repo built here.
  const sessionEventsRef = new LateRef<Pick<SessionService, 'logEvent' | 'knowledgeDiscarded'>>(
    'the session service'
  )
  const knowledgeSuggestionsRepo = new KnowledgeSuggestionsRepo(db)
  const knowledgeSuggestions = new KnowledgeSuggestionService({
    repo: knowledgeSuggestionsRepo,
    sectionsRepo,
    getKnowledgeRoot,
    knowledge: knowledgeService,
    itemsRepo,
    emitChanged: (payload) => emit('knowledge:changed', payload),
    isStorageLocked: (groupId) => storageService.isLocked(groupId),
    logSessionEvent: (sessionId, kind, text, data) =>
      sessionEventsRef.get().logEvent(sessionId, kind, text, data),
    publish: (sessionId, waiting) => emit('session:knowledge-suggestions', { sessionId, waiting }),
    onDiscarded: (sessionId, titles) => sessionEventsRef.get().knowledgeDiscarded(sessionId, titles)
  })
  const shellService = createShellService({
    env: process.env,
    openExternal: (url) => shell.openExternal(url),
    readLinkUrl: (itemId) => knowledgeService.readLinkUrl(itemId),
    resolveRevealPath: createRevealResolver({ sectionsRepo, itemsRepo, getKnowledgeRoot }),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path)
  })
  const projectService = new ProjectService({ db, projectsRepo, dialogs })
  return {
    availability,
    itemsRepo,
    getKnowledgeRoot,
    knowledgeIndex,
    sectionService,
    knowledgeWatcher,
    storageService,
    knowledgeService,
    knowledgeSuggestions,
    knowledgeSuggestionsRepo,
    sessionEventsRef,
    shellService,
    projectService
  }
}
type KnowledgeServices = ReturnType<typeof buildKnowledgeServices>

function buildAgentConfigServices(core: CoreServices, providers: ProviderServices) {
  const { db, resolver, supervisor, appSettings } = core
  const { providerStatus, codexProbe, codexCommands, cursorCommands } = providers
  const mcpDir = join(app.getPath('userData'), 'mcp')
  // Config files of agents from an earlier run hold dead tokens; none is in use yet.
  rmSync(mcpDir, { recursive: true, force: true })
  const bridge = new BridgeServer({ configDir: mcpDir, log: sessionsLog })
  const loadOff = createLoadSelection(() => appSettings.get('agents.loadOff'))
  const pluginView = new PluginViewService({
    baseDir: join(app.getPath('userData'), 'agent-plugins'),
    listInstalled: createClaudePluginLister({ resolver }),
    off: loadOff,
    log: sessionsLog,
    onChanged: () => emit('commands:changed', {})
  })
  const agentConfigDir = join(app.getPath('userData'), 'agent-config')
  // The merged MCP files of agents from an earlier run hold dead bridge tokens; none is in use yet.
  rmSync(agentConfigDir, { recursive: true, force: true })
  const bypassDetector = new BypassDetector({ plugins: pluginView, off: loadOff, log: sessionsLog })
  const mcpTools = new McpToolCatalogue()
  const personalConfig = new PersonalConfigService({
    baseDir: agentConfigDir,
    plugins: pluginView,
    codexServers: (cwd) => codexProbe.listMcpServers(cwd),
    off: loadOff,
    mcp: mcpTools,
    bypass: (repoPaths) => bypassDetector.detect(repoPaths),
    log: sessionsLog
  })
  // Right after launch the first check may still be running: wait for it instead of answering "not set up".
  const providerReady = async (provider: 'codex' | 'cursor'): Promise<boolean> => {
    if (!providerStatus.getStatus(provider))
      await providerStatus.ensureFresh(provider).catch(() => undefined)
    return providerStatus.getStatus(provider)?.state === 'ok'
  }
  const loadCatalogue = new LoadCatalogue({
    projectPaths: () => new ProjectsRepo(db).allPaths(),
    plugins: pluginView,
    codex: {
      ready: () => providerReady('codex'),
      servers: (cwd) => personalConfig.codexMcp(cwd)
    },
    cursor: { ready: () => providerReady('cursor') },
    knownTools: () => mcpTools.knownTools(),
    log: sessionsLog
  })
  const commandCatalogue = new CommandCatalogue({
    probe: new CommandProbe({
      supervisor,
      binary: resolver.claudeBinary(),
      resolvePath: () => resolver.resolvePath()
    }),
    codex: { list: (cwds, refresh) => codexCommands.list(cwds, refresh) },
    cursor: { list: (cwds, refresh) => cursorCommands.list(cwds, refresh) },
    getPersonal: (repoPaths) => personalConfig.claude({ repoPaths, role: 'workers' }),
    getViewDir: async (repoPaths, refresh) => {
      // Commands run in workers, so the list comes from the workers' view.
      const dir = await pluginView.current(repoPaths, 'workers')
      return refresh ? pluginView.rebuild() : dir
    },
    log: sessionsLog
  })
  return { bridge, pluginView, bypassDetector, personalConfig, loadCatalogue, commandCatalogue }
}
type AgentConfigServices = ReturnType<typeof buildAgentConfigServices>

function buildUsageServices(
  core: CoreServices,
  providers: ProviderServices,
  planUsage: LateRef<PlanUsageService>
) {
  const { db, resolver } = core
  const { providerStatus, codexProbe, models } = providers
  const usageRepo = new UsageRepo(db)
  const suggestionsRepo = new UsageSuggestionsRepo(db)
  // The suggestions read and notify the recorder that is built from them.
  const recorderRef = new LateRef<UsageRecorder>('the usage recorder')
  const suggestions = new SuggestionService({
    repo: suggestionsRepo,
    fileReads: new FileReadsRepo(db),
    usage: usageRepo,
    agents: (sessionId) => recorderRef.get().snapshot(sessionId, false).agents,
    models,
    onChanged: (sessionId) => recorderRef.get().suggestionsChanged(sessionId),
    now: Date.now,
    newId: randomUUID,
    log: sessionsLog
  })
  const usage = new UsageRecorder({
    repo: usageRepo,
    suggestions,
    setupRepo: new AgentSetupRepo(db),
    sessionsRepo: new SessionsRepo(db),
    groupsRepo: new GroupsRepo(db),
    workersRepo: new WorkersRepo(db),
    emit: (snapshot) => emit('usage:session-changed', snapshot),
    emitChanged: () => emit('usage:changed', {}),
    now: Date.now,
    log: sessionsLog
  })
  recorderRef.bind(usage)
  const plans = new PlanUsageService({
    repo: new PlanLimitsRepo(db),
    providers: () => providerStatus.get(),
    notices: new PlanNotices(new PlanNoticesRepo(db)),
    publish: (snapshot) => emit('plan:changed', snapshot),
    log: sessionsLog
  })
  planUsage.bind(plans)
  const codexLimits = new CodexRateLimitReader({
    source: codexProbe,
    plans,
    status: () => providerStatus.get(),
    log: sessionsLog
  })
  const cursorPlan = new CursorPlanReader({
    tier: () => resolver.cursorSubscriptionTier(),
    plans,
    status: () => providerStatus.get(),
    log: sessionsLog
  })
  return { usageRepo, suggestionsRepo, suggestions, usage, plans, codexLimits, cursorPlan }
}
type UsageServices = ReturnType<typeof buildUsageServices>

function buildSessionServices(
  core: CoreServices,
  createWindow: () => BrowserWindow,
  knowledge: KnowledgeServices,
  providers: ProviderServices,
  agentConfig: AgentConfigServices,
  usage: UsageServices
) {
  const { db, resolver, supervisor, appSettings } = core
  const { providerStatus, codexCommands, cursorCommands, models } = providers
  const git = createGit()
  const sessionGit = createSessionGit(git)
  const mergeGit = createMergeGit(git, sessionGit)
  const sessionProjectsRepo = new SessionProjectsRepo(db)
  const mergeQueue = new MergeQueue()
  const pushGit = createPushGit()
  const worktreeGit = createWorktreeGit(git)
  const reviewService = new ReviewService({
    sessionProjectsRepo,
    mergeGit,
    reviewGit: createReviewGit(git),
    pushGit,
    attribution: createAttribution({
      git,
      workersRepo: new WorkersRepo(db),
      commitsRepo: new CommitsRepo(db),
      mergesRepo: new MergesRepo(db)
    }),
    marksRepo: new ReviewMarksRepo(db),
    log: sessionsLog
  })
  const notesService = new NotesService({
    notesRepo: new ReviewNotesRepo(db),
    sessionProjectsRepo,
    reviewService,
    log: sessionsLog
  })
  const getWorktreesRoot = (): string => join(app.getPath('userData'), 'worktrees')
  const undoService = new UndoService({
    reviewService,
    workersRepo: new WorkersRepo(db),
    worktreesRepo: new WorktreesRepo(db),
    worktreeGit,
    mergeGit,
    git,
    queue: mergeQueue,
    marksRepo: new ReviewMarksRepo(db),
    getWorktreesRoot,
    log: sessionsLog
  })
  const pushService = new PushService({
    sessionProjectsRepo,
    mergeGit,
    pushGit,
    log: sessionsLog
  })
  // The service reports attention changes to the attention service that is built from it.
  const attentionRef = new LateRef<AttentionService>('the attention service')
  const messageAttachmentsRepo = new MessageAttachmentsRepo(db)
  const branchQuestionsRepo = new BranchQuestionsRepo(db)
  const stagingRoot = join(app.getPath('userData'), 'attachment-staging')
  // Staged files do not survive a restart; cleared before any renderer can stage (tech spec 2.3).
  clearStagingRoot(stagingRoot, sessionsLog)
  const attachments = new AttachmentService({
    stagingRoot,
    dialogs: core.dialogs,
    makeThumbnail: makeNativeThumbnail
  })
  const getSessionDir = (sessionId: string): string =>
    join(app.getPath('userData'), 'sessions', sessionId)
  const sessions = new SessionService({
    branchQuestionsRepo,
    messageAttachmentsRepo,
    attachmentSender: new AttachmentSender({
      db,
      staging: attachments,
      getSessionDir,
      now: () => Date.now(),
      log: sessionsLog
    }),
    usage: usage.usage,
    planUsage: usage.plans,
    plansRepo: new PlansRepo(db),
    workersRepo: new WorkersRepo(db),
    worktreesRepo: new WorktreesRepo(db),
    heldMessagesRepo: new HeldMessagesRepo(db),
    commitsRepo: new CommitsRepo(db),
    attentionRepo: new AttentionRepo(db),
    knowledgeSuggestionsRepo: knowledge.knowledgeSuggestionsRepo,
    knowledgeItemsRepo: knowledge.itemsRepo,
    knowledgeSuggestions: knowledge.knowledgeSuggestions,
    allowRulesRepo: new AllowRulesRepo(db),
    worktreeGit,
    mergesRepo: new MergesRepo(db),
    mergeGit,
    reviewService,
    notesService,
    undoService,
    pushService,
    mergeQueue,
    bridge: agentConfig.bridge,
    getWorktreesRoot,
    sessionsRepo: new SessionsRepo(db),
    brainThreadsRepo: new BrainThreadsRepo(db),
    messagesRepo: new MessagesRepo(db),
    eventsRepo: new EventsRepo(db),
    groupsRepo: new GroupsRepo(db),
    projectsRepo: new ProjectsRepo(db),
    sessionProjectsRepo,
    sessionGit,
    getKnowledgeRoot: knowledge.getKnowledgeRoot,
    getSessionDir,
    getCodexBrainDir: (sessionId) => join(app.getPath('userData'), 'codex-brain', sessionId),
    getPluginViewDir: (repoPaths, role) => agentConfig.pluginView.current(repoPaths, role),
    personal: agentConfig.personalConfig,
    repoSettings: new RepoSettingsWarner(),
    commands: agentConfig.commandCatalogue,
    codexCommands,
    cursorCommands,
    models,
    providers: providerStatus,
    appSettings,
    suggestKnowledge: () => appSettings.get('knowledge.suggestOnFinish'),
    onSettingsSaved: () => emit('settings:changed', appSettings.getAll()),
    registry: new AdapterRegistry({
      claude: new ClaudeAdapter({
        supervisor,
        binary: resolver.claudeBinary(),
        resolvePath: () => resolver.resolvePath(),
        warn: (message) => sessionsLog.warn(message)
      }),
      codex: new CodexAdapter({
        supervisor,
        binary: resolver.codexBinary(),
        resolvePath: () => resolver.resolvePath(),
        clientVersion: app.getVersion()
      }),
      cursor: new CursorAdapter({
        supervisor,
        binary: () => resolver.cursorBinary(),
        resolvePath: () => resolver.resolvePath(),
        version: () => providerStatus.getStatus('cursor')?.version
      })
    }),
    getCliStatus: () => providerStatus.getStatus('claude'),
    recheckCli: async () => {
      await providerStatus.check('claude')
      const claude = providerStatus.getStatus('claude')
      if (!claude) throw new Error('claude check produced no status')
      return claude
    },
    onSignedOut: () => providerStatus.markSignedOut('claude'),
    emit,
    onAttentionChanged: (sessionId, state) =>
      attentionRef.get().onAttentionChanged(sessionId, state),
    onBranchQuestionsChanged: (sessionId) => attentionRef.get().onBranchQuestionsChanged(sessionId),
    log: sessionsLog
  })
  const notifications = new NotificationService({
    env: process.env,
    isSupported: () => Notification.isSupported(),
    isAppFocused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    create: (options) => {
      const n = new Notification(options)
      return { onClick: (listener) => n.on('click', listener), show: () => n.show() }
    },
    ensureWindow: () => {
      const existing = getMainWindow()
      return existing
        ? { window: existing, created: false }
        : { window: createWindow(), created: true }
    }
  })
  const workersRepo = new WorkersRepo(db)
  const attention = new AttentionService({
    sessions,
    attentionRepo: new AttentionRepo(db),
    branchQuestionsRepo,
    sessionsRepo: new SessionsRepo(db),
    workerOf: (id) => workersRepo.get(id),
    emit,
    onNewRequest: (notice) => notifications.notify(notice),
    log: sessionsLog
  })
  attentionRef.bind(attention)
  return { sessions, attention, attachments, messageAttachmentsRepo, branchQuestionsRepo }
}

/**
 * Constructs every service in dependency order and returns them as one record. Nothing is started
 * here (see `startServices`). The few real cycles go through a `LateRef` that throws if used early.
 */
export function buildServices(deps: BuildServicesDeps): AppServices {
  const { db, dialogs } = deps
  const resolver = new CliResolver({ isPackaged: app.isPackaged, log: cliLog })
  const core: CoreServices = {
    db,
    dialogs,
    resolver,
    supervisor: new ProcessSupervisor({ ledger: new PidLedger(pidLedgerPath()) }),
    appSettings: new AppSettingsRepo(db)
  }
  // Provider status publishes to the plan meters, which read the provider status back.
  const planUsage = new LateRef<PlanUsageService>('the plan usage service')
  const providers = buildProviderServices(core, planUsage)
  const knowledge = buildKnowledgeServices(core)
  const agentConfig = buildAgentConfigServices(core, providers)
  const usage = buildUsageServices(core, providers, planUsage)
  const sessionServices = buildSessionServices(
    core,
    deps.createWindow,
    knowledge,
    providers,
    agentConfig,
    usage
  )
  const { sessions } = sessionServices
  knowledge.sessionEventsRef.bind(sessions)
  const { providerStatus, models } = providers

  const groupService = new GroupService({
    db,
    groupsRepo: new GroupsRepo(db),
    appDataDir: app.getPath('userData'),
    log: knowledgeLog,
    exportKnowledge: (groupId, token) => knowledge.storageService.exportKnowledge(groupId, token),
    withStorageLock: (groupId, task) => knowledge.storageService.withLock(groupId, task),
    stopWatcher: async (groupId) => {
      await knowledge.knowledgeWatcher.stopFor(groupId)
    },
    removeSessions: async (groupId) => {
      await sessions.removeForGroup(groupId)
    }
  })
  const pluginService = new PluginService({
    resolver,
    log: sessionsLog,
    onProgress: (event) => emit('plugins:progress', event),
    onChanged: async () => {
      // The view's own onChanged pushes commands:changed when its hash moved.
      await agentConfig.pluginView.rebuild()
      agentConfig.commandCatalogue.invalidate()
      emit('plugins:changed', {})
      await sessions.pluginsChanged()
    }
  })
  const planTarget = planProbeTarget(process.env, resolver.claudeBinary(), app.isPackaged)
  const claudePlanProbe = planTarget
    ? new ClaudePlanProbe({
        supervisor: core.supervisor,
        binary: planTarget.binary,
        binaryArgs: planTarget.binaryArgs,
        resolvePath: () => resolver.resolvePath(),
        cwd: join(app.getPath('userData'), 'plan-probe'),
        settingsPath: join(app.getPath('userData'), 'plan-probe-settings.json'),
        models,
        plans: usage.plans,
        recorder: usage.usage,
        isEnabled: () => core.appSettings.get('usage.checkClaudePlanOnLaunch'),
        isClaudeReady: () => providerStatus.getStatus('claude')?.state === 'ok',
        isRateLimitPaused: () => sessions.anyRateLimitWaiting('claude'),
        log: sessionsLog
      })
    : undefined
  const providerChecks = new ProviderChecks({
    providers: providerStatus,
    models,
    codexCommands: providers.codexCommands,
    cursorCommands: providers.cursorCommands,
    codexLimits: usage.codexLimits,
    cursorPlan: usage.cursorPlan,
    claudePlanProbe,
    emit,
    log: cliLog
  })
  return {
    ...core,
    ...providers,
    ...knowledge,
    ...agentConfig,
    ...usage,
    ...sessionServices,
    groupService,
    pluginService,
    claudePlanProbe,
    providerChecks
  }
}

/** The background work that starts once everything is built: the bridge, the plugin view, the readers. */
export function startServices(services: AppServices): void {
  void services.bridge
    .start()
    .catch((e: unknown) => sessionsLog.error('could not start the MCP bridge', e))
  // Built in the background; agents started before it finishes wait for the same build.
  void services.pluginView.rebuild()
  services.plans.pruneNotices()
  services.codexLimits.start()
  // A crash can leave a temporary merge working copy behind; git forgets removed ones on prune.
  void services.sessions
    .sweepWorktrees()
    .catch((e: unknown) => sessionsLog.warn('worktree sweep failed', e))
}
