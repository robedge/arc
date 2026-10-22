import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  Notification,
  nativeTheme,
  type Rectangle,
  screen,
  session,
  shell
} from 'electron'
import { MigrationError, openDatabase, resolveMigrationsFolder } from '../db/client'
import type { Db } from '../db/client'
import { AppErrorException } from '@shared/errors'
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
import { SectionService } from '../knowledge/section-service'
import { KnowledgeWatcher } from '../knowledge/knowledge-watcher'
import { KnowledgeStorageService } from '../knowledge/knowledge-storage-service'
import { recoverStorage } from '../knowledge/storage-recovery'
import { createRevealResolver } from '../knowledge/reveal-path'
import { AvailabilityService } from '../knowledge/availability-service'
import type { Project } from '@shared/types/project'
import type { StorageState } from '@shared/types/storage'
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
import { ClaudeAdapter } from '../agents/claude-adapter'
import { CodexAdapter } from '../agents/codex/codex-adapter'
import { CodexCommands } from '../agents/codex/codex-commands'
import { CursorCommands } from '../agents/cursor/cursor-commands'
import { CodexProbe } from '../agents/codex/codex-probe'
import { CursorAdapter } from '../agents/cursor/cursor-adapter'
import { CursorProbe } from '../agents/cursor/cursor-probe'
import { ModelRegistry } from '../models/model-registry'
import { LatestVersions } from '../providers/provider-versions'
import { AppSettingsRepo } from '../db/repositories/app-settings-repo'
import { AgentSetupRepo } from '../db/repositories/agent-setup-repo'
import { UsageRepo } from '../db/repositories/usage-repo'
import { UsageRecorder } from '../usage/usage-recorder'
import { SuggestionService } from '../usage/suggestion-service'
import { UsageSuggestionsRepo } from '../db/repositories/usage-suggestions-repo'
import { FileReadsRepo } from '../db/repositories/file-reads-repo'
import { buildUsageReport } from '../usage/usage-report'
import { PlanNotices } from '../usage/plan-notices'
import { PlanNoticesRepo } from '../db/repositories/plan-notices-repo'
import { PlanUsageService } from '../usage/plan-usage-service'
import { CodexRateLimitReader } from '../usage/codex-rate-limit-reader'
import { CursorPlanReader } from '../usage/cursor-plan-reader'
import { ClaudePlanProbe, planProbeTarget } from '../usage/claude-plan-probe'
import { PlanLimitsRepo } from '../db/repositories/plan-limits-repo'
import { AdapterRegistry } from '../agents/provider-registry'
import { PidLedger, sweepOrphans } from '../agents/pid-ledger'
import { ProcessSupervisor } from '../agents/process-supervisor'
import { recoverAtStartup } from '../sessions/startup-recovery'
import { EventsRepo } from '../db/repositories/events-repo'
import { MessagesRepo } from '../db/repositories/messages-repo'
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
import type { GroupChange } from '../sessions/session-service'
import { emit, handle } from '../ipc/register'
import { cliLog, configureLogging, dbLog, knowledgeLog, log, sessionsLog } from '../logging'
import { enabledExtensions } from '../knowledge/import-types'
import { createDialogs } from '../platform/dialogs'
import type { Dialogs } from '../platform/dialogs'
import { createShellService } from '../platform/shell-service'
import { handleKnowledgeProtocol, registerKnowledgeScheme } from '../protocol/knowledge-protocol'
import { buildCsp } from './csp'
import { isSmokeRun, runSmoke } from './smoke'
import { createCloseGate } from './close-gate'
import type { CloseGate } from './close-gate'
import { getMainWindow, setMainWindow } from './main-window'
import { mainWindowOptions, showWindow, withE2eOffscreen } from './window-options'
import { lockDownWindow } from './lockdown'
import { buildAppMenuTemplate } from './app-menu'
import { openDesignPreview } from './preview-window'

let database: { db: Db; close: () => void } | undefined
let dialogs: Dialogs | undefined
let closeGate: CloseGate | undefined
let isQuitting = false
let shuttingDown = false
let shutdownDone = false

const CLOSE_FLUSH_TIMEOUT_MS = 2000
/** Logged when the renderer never answered the close handshake (e2e asserts it is absent). */
const CLOSE_GATE_TIMEOUT_MESSAGE = '[close-gate] timed out waiting for the renderer'

/** The open application database. Only valid after startup has opened it. */
export function getDb(): Db {
  if (!database) throw new Error('Database is not open yet')
  return database.db
}

export function getDialogs(): Dialogs {
  if (!dialogs) throw new Error('Dialogs are not initialised yet')
  return dialogs
}

function openAppDatabase(): void {
  const migrationsFolder = resolveMigrationsFolder({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appRoot: resolve(import.meta.dirname, '../..') // out/main -> project root
  })
  mkdirSync(app.getPath('userData'), { recursive: true })
  const opened = openDatabase({
    dbPath: join(app.getPath('userData'), 'arc.db'),
    migrationsFolder
  })
  if (opened.backupPath) dbLog.info(`backed up before migration to ${opened.backupPath}`)
  database = { db: opened.db, close: () => opened.sqlite.close() }
}

function rendererDevUrl(): string | undefined {
  return !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
}

const displayBounds = (): Rectangle[] => screen.getAllDisplays().map((d) => d.bounds)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow(
    withE2eOffscreen(
      mainWindowOptions(join(import.meta.dirname, '../preload/index.cjs')),
      process.env,
      displayBounds
    )
  )

  // The close handshake only works once the renderer has loaded and registered its listener;
  // before that (or after a crash) the push event would be lost and the gate would stall.
  let rendererReady = false
  win.webContents.on('did-finish-load', () => {
    rendererReady = true
  })
  win.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  win.webContents.on('render-process-gone', () => {
    rendererReady = false
  })
  win.once('ready-to-show', () => showWindow(win, process.env))

  const devUrl = rendererDevUrl()
  lockDownWindow(win, devUrl ? { origin: devUrl } : { exact: () => win.webContents.getURL() })

  if (devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
  // Close handshake: let the renderer flush unsaved edits before the window goes away.
  const gate = createCloseGate({
    emit: () => emit('app:before-close', {}),
    canFlush: () => rendererReady,
    timeoutMs: CLOSE_FLUSH_TIMEOUT_MS,
    onTimeout: () => console.warn(CLOSE_GATE_TIMEOUT_MESSAGE)
  })
  closeGate = gate
  win.on('close', (event) =>
    // Never call app.quit() from inside the close handler: re-entering quit while this
    // window's close is mid-dispatch can leave Electron's quit sequence stalled forever.
    gate.handleClose(event, () => win.close())
  )
  setMainWindow(win)
  win.on('closed', () => {
    setMainWindow(null)
    // Quit only once the window is really gone (before-quit then has nothing to gate).
    if (isQuitting) app.quit()
  })
  return win
}

let availability: AvailabilityService | undefined
let cliResolver: CliResolver | undefined
let pluginViewService: PluginViewService | undefined
let pluginServiceRef: PluginService | undefined
let providerStatus: ProviderStatusService | undefined
let modelRegistry: ModelRegistry | undefined
let codexCommands: CodexCommands | undefined
let cursorCommands: CursorCommands | undefined
let appSettingsRef: AppSettingsRepo | undefined

/** A focus after this long since the last full check runs another (functional spec 2.8). */
const PROVIDER_RECHECK_AFTER_MS = 10 * 60 * 1000
let lastFullCheckAt = 0

function getProviderStatus(): ProviderStatusService {
  cliResolver ??= new CliResolver({ isPackaged: app.isPackaged, log: cliLog })
  const resolver = cliResolver
  providerStatus ??= new ProviderStatusService({
    checker: resolver,
    publish: (map) => {
      emit('providers:changed', map)
      // A provider becoming set up (or not) adds or removes its meter.
      planUsage?.refreshMeters()
    },
    latest: new LatestVersions({
      isPackaged: app.isPackaged,
      cachePath: join(app.getPath('userData'), 'provider-cache.json'),
      log: { debug: (message, ...rest) => cliLog.debug(message, ...rest) },
      sources: { cursor: () => resolver.cursorLatestVersion() }
    }),
    locate: (provider) => resolver.locateBinary(provider),
    dismissals: {
      get: (provider) => appSettingsRef?.getDismissedUpdate(provider),
      set: (provider, version) => appSettingsRef?.setDismissedUpdate(provider, version, Date.now())
    },
    // Coarse: any live agent process counts, whichever provider it runs on.
    hasRunningAgents: () => (supervisor?.liveCount ?? 0) > 0,
    log: cliLog
  })
  return providerStatus
}

/** The Cursor command files are read again (Check again, app start); the `/` list is told. */
function refreshCursorCommands(): void {
  if (!cursorCommands) return
  cursorCommands.invalidate()
  emit('commands:changed', {})
}

/** The Codex skills and prompts are read again (Check again, app start); the `/` list is told. */
function refreshCodexCommands(): void {
  if (!codexCommands) return
  codexCommands.invalidate()
  emit('commands:changed', {})
}

/**
 * A full check: status, the latest versions, and the model lists. A changed model list pushes
 * `providers:changed` again so the pickers refetch. Used at launch, by Check again and on focus.
 */
async function runFullCheck(options: { forceLatest?: boolean } = {}): Promise<void> {
  lastFullCheckAt = Date.now()
  const providers = getProviderStatus()
  await providers.check(undefined, options)
  // The Codex model list follows the status; a forced refresh sees models added since the last one.
  if (await modelRegistry?.refresh({ force: true })) emit('providers:changed', providers.get())
  refreshCodexCommands()
  // The model refresh above has run Cursor's probe, so its command list is current.
  refreshCursorCommands()
  // Codex's limits are read once its status is known (this is also the launch read).
  void codexLimits?.refresh()
  // Cursor's meter ("Not reported", with the subscription tier) likewise.
  void cursorPlan?.refresh()
  // Claude's meter gets its launch value once Claude's status is known; at most once per launch.
  void claudePlanProbe?.runOnce()
}

/** Background check at startup; the renderer gets the result when it arrives or once it has loaded. */
function startProviderCheck(): void {
  runFullCheck().catch((e: unknown) => {
    cliLog.error('provider check failed', e)
  })
}

/** On window focus: another full check once the last one is 10 minutes old. */
function recheckProvidersOnFocus(): void {
  if (Date.now() - lastFullCheckAt < PROVIDER_RECHECK_AFTER_MS) return
  startProviderCheck()
}

let knowledgeWatcher: KnowledgeWatcher | undefined
/** True when both lists hold the same keys, in any order. */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((key) => b.includes(key))
}

let sessionService: SessionService | undefined
let usageRecorder: UsageRecorder | undefined
let planUsage: PlanUsageService | undefined
let codexLimits: CodexRateLimitReader | undefined
let cursorPlan: CursorPlanReader | undefined
let claudePlanProbe: ClaudePlanProbe | undefined
let attention: AttentionService | undefined
let supervisor: ProcessSupervisor | undefined
let bridgeServer: BridgeServer | undefined
/** Set once the storage service exists; GroupService reaches it lazily for export and locking. */
let storageServiceRef: KnowledgeStorageService | undefined

/** Re-scans the open group's knowledge (called when the window regains focus). */
function rescanKnowledge(): void {
  void knowledgeWatcher?.rescan()
}

function registerHandlers(): void {
  handle('app:ping', () => ({ version: app.getVersion() }))
  handle('app:close-ready', () => closeGate?.ready())
  cliResolver ??= new CliResolver({ isPackaged: app.isPackaged, log: cliLog })
  handle('providers:get', () => getProviderStatus().get())
  handle('providers:check', async ({ provider }) => {
    if (provider === undefined) {
      await runFullCheck({ forceLatest: true })
      return getProviderStatus().get()
    }
    const map = await getProviderStatus().check(provider, { forceLatest: true })
    // Check again also reloads the Codex models (the account may have changed). Not awaited: the next
    // `providers:models` call waits for the same refresh.
    if (provider !== 'claude') {
      void modelRegistry?.refresh({ force: true }).then((changed) => {
        if (changed) emit('providers:changed', getProviderStatus().get())
        if (provider === 'cursor') refreshCursorCommands()
      })
      if (provider === 'codex') refreshCodexCommands()
    }
    return map
  })
  handle('providers:dismiss-update', ({ provider, version }) => {
    const providers = getProviderStatus()
    providers.dismissUpdate(provider, version)
    return providers.get()
  })
  // The quit path stays the existing one (before-quit routes through the close gate), so unsaved work
  // is flushed first; the relaunch is queued before it.
  handle('app:relaunch', () => {
    app.relaunch()
    app.quit()
  })
  const groupService = new GroupService({
    db: getDb(),
    groupsRepo: new GroupsRepo(getDb()),
    appDataDir: app.getPath('userData'),
    exportKnowledge: (groupId, token) => {
      if (!storageServiceRef) throw new AppErrorException('INTERNAL')
      return storageServiceRef.exportKnowledge(groupId, token)
    },
    withStorageLock: (groupId, task) =>
      storageServiceRef ? storageServiceRef.withLock(groupId, task) : task(),
    stopWatcher: async (groupId) => {
      await knowledgeWatcher?.stopFor(groupId)
    },
    removeSessions: async (groupId) => {
      await sessionService?.removeForGroup(groupId)
    }
  })
  handle('groups:list', () => groupService.list())
  handle('groups:create', ({ name }) => groupService.create(name))
  handle('groups:rename', ({ groupId, name }) => groupService.rename(groupId, name))
  handle('groups:delete', ({ groupId, exportTo }) => groupService.delete(groupId, exportTo))
  availability = new AvailabilityService({
    projectsRepo: new ProjectsRepo(getDb()),
    listGroupIds: () => new GroupsRepo(getDb()).list().map((g) => g.id),
    getLinkedRoot: (groupId) => {
      const row = new KnowledgeStorageRepo(getDb()).get(groupId)
      return row?.mode === 'linked' ? row.linkedPath : null
    },
    // Restarting the watcher either closes it cleanly (root gone: start() finds no folder and
    // keeps no handle) or re-creates it and rescans (root back).
    onKnowledgeRootChange: async (groupId) => {
      if (knowledgeWatcher?.watchedGroupId === groupId) await knowledgeWatcher.start(groupId)
    },
    emit
  })
  const sectionsRepo = new SectionsRepo(getDb())
  const itemsRepo = new KnowledgeItemsRepo(getDb())
  const metaStore = new MetaStore({ log: knowledgeLog })
  const getKnowledgeRoot = createKnowledgeRootResolver({
    storageRepo: new KnowledgeStorageRepo(getDb()),
    appDataDir: app.getPath('userData')
  })
  const knowledgeIndex = new KnowledgeIndex({
    sectionsRepo,
    itemsRepo,
    metaStore,
    getKnowledgeRoot,
    log: knowledgeLog
  })
  handleKnowledgeProtocol({
    getItem: (id) => itemsRepo.getById(id),
    getKnowledgeRoot,
    log: knowledgeLog
  })
  handle('groups:open', async ({ groupId }) => {
    await knowledgeIndex.reconcileGroup(groupId).catch((e: unknown) => {
      knowledgeLog.warn('reconcile on group open failed', e)
    })
    await knowledgeWatcher?.start(groupId)
    return availability?.setOpenGroup(groupId)
  })

  const projectService = new ProjectService({
    db: getDb(),
    projectsRepo: new ProjectsRepo(getDb()),
    dialogs: getDialogs()
  })
  const recordBaselines = (projects: Project[]): void => {
    for (const p of projects) availability?.recordBaseline(p.id, p.available)
  }
  handle('projects:list', async ({ groupId }) => {
    const projects = await projectService.list(groupId)
    recordBaselines(projects)
    return projects
  })
  // Open sessions take a group change without a restart (functional spec 2.11). It runs in the
  // background: the project or storage call has already succeeded and its answer is not delayed.
  const groupChanged = (groupId: string | null, change: GroupChange): void => {
    void sessionService?.groupChanged(groupId, change).catch((e: unknown) => {
      sessionsLog.error('could not apply a group change to the open sessions', e)
    })
  }
  handle('projects:pick', async ({ groupId }) => {
    const result = await projectService.pick(groupId)
    recordBaselines(result.added)
    if (result.added.length > 0) groupChanged(groupId, { kind: 'projects' })
    return result
  })
  handle('projects:add', async ({ groupId, paths }) => {
    const result = await projectService.add(groupId, paths)
    recordBaselines(result.added)
    if (result.added.length > 0) groupChanged(groupId, { kind: 'projects' })
    return result
  })
  handle('projects:remove', ({ groupId, projectId }) => {
    projectService.remove(groupId, projectId)
    groupChanged(groupId, { kind: 'projects' })
  })
  handle('projects:relocate', async ({ groupId, projectId }) => {
    const project = await projectService.relocate(groupId, projectId)
    recordBaselines([project])
    await availability?.checkGroup(groupId)
    // A project can belong to several groups: its new folder reaches all of their sessions.
    groupChanged(null, { kind: 'projects' })
    return project
  })

  const sectionService = new SectionService({
    sectionsRepo,
    getKnowledgeRoot,
    metaStore,
    log: knowledgeLog
  })
  knowledgeWatcher = new KnowledgeWatcher({
    getKnowledgeRoot,
    index: knowledgeIndex,
    sectionsRepo,
    itemsRepo,
    adoptFolders: (groupId) => sectionService.adoptFolders(groupId),
    emit,
    // Root renamed or deleted while open: re-check availability now rather than at the next tick.
    onRootGone: (groupId) => void availability?.checkGroup(groupId),
    log: knowledgeLog
  })
  const storageRepo = new KnowledgeStorageRepo(getDb())
  const storageService = new KnowledgeStorageService({
    storageRepo,
    projectsRepo: new ProjectsRepo(getDb()),
    sectionsRepo,
    metaStore,
    dialogs: getDialogs(),
    groupsRepo: new GroupsRepo(getDb()),
    watcher: knowledgeWatcher,
    index: knowledgeIndex,
    adoptFolders: (groupId) => sectionService.adoptFolders(groupId),
    listGroupIds: () => new GroupsRepo(getDb()).list().map((g) => g.id),
    appDataDir: app.getPath('userData'),
    emit,
    log: knowledgeLog
  })
  // Whatever status the renderer is given becomes the baseline the next availability check compares to.
  const reportStorage = (groupId: string, state: StorageState): StorageState => {
    availability?.recordKnowledgeBaseline(groupId, state.mode === 'linked' ? state.available : null)
    return state
  }
  handle('storage:get', async ({ groupId }) =>
    reportStorage(groupId, await storageService.getState(groupId))
  )
  handle('storage:pickFolder', ({ groupId }) => storageService.pickFolder(groupId))
  handle('storage:link', async ({ groupId, token, choice }) => {
    const state = reportStorage(groupId, await storageService.link(groupId, token, choice))
    groupChanged(groupId, { kind: 'knowledge' })
    return state
  })
  handle('storage:unlink', async ({ groupId, choice }) => {
    const state = reportStorage(groupId, await storageService.unlink(groupId, choice))
    groupChanged(groupId, { kind: 'knowledge' })
    return state
  })
  handle('storage:locate', async ({ groupId }) => {
    const result = await storageService.locate(groupId)
    if (result.located) {
      reportStorage(groupId, result.state)
      groupChanged(groupId, { kind: 'knowledge' })
    }
    return result
  })
  handle('storage:useAppStorage', async ({ groupId }) => {
    const state = reportStorage(groupId, await storageService.useAppStorage(groupId))
    groupChanged(groupId, { kind: 'knowledge' })
    return state
  })
  handle('storage:pickExportFolder', ({ groupId }) => storageService.pickExportFolder(groupId))
  handle('storage:export', ({ groupId, token }) => storageService.exportKnowledge(groupId, token))
  storageServiceRef = storageService
  handle('sections:list', ({ groupId }) => sectionService.list(groupId))
  handle('sections:create', ({ groupId, name }) => sectionService.create(groupId, name))
  handle('sections:rename', ({ sectionId, name }) => sectionService.rename(sectionId, name))
  handle('sections:delete', ({ sectionId }) => sectionService.delete(sectionId))

  const knowledgeService = new KnowledgeService({
    sectionsRepo,
    itemsRepo,
    index: knowledgeIndex,
    metaStore,
    getKnowledgeRoot
  })
  const shellService = createShellService({
    env: process.env,
    openExternal: (url) => shell.openExternal(url),
    readLinkUrl: (itemId) => knowledgeService.readLinkUrl(itemId),
    resolveRevealPath: createRevealResolver({ sectionsRepo, itemsRepo, getKnowledgeRoot }),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path)
  })
  handle('links:upsert', (input) => knowledgeService.upsertLink(input))
  handle('shell:openLink', ({ itemId }) => shellService.openLink(itemId))
  handle('shell:openUrl', ({ url }) => shellService.openUrl(url))
  handle('shell:reveal', (target) => shellService.reveal(target))
  handle('items:list', ({ sectionId }) => knowledgeService.list(sectionId))
  handle('items:read', ({ itemId }) => knowledgeService.read(itemId))
  handle('items:create', ({ sectionId, title, description }) =>
    knowledgeService.create(sectionId, title, description)
  )
  handle('items:save', ({ itemId, content, baseRevision }) =>
    knowledgeService.save(itemId, content, baseRevision)
  )
  handle('items:rename', ({ itemId, title }) => knowledgeService.rename(itemId, title))
  handle('items:setDescription', ({ itemId, description }) =>
    knowledgeService.setDescription(itemId, description)
  )
  handle('items:delete', ({ itemId }) => knowledgeService.delete(itemId))
  handle('items:pickImport', async ({ sectionId }) => {
    const paths = await getDialogs().pickFiles({
      multi: true,
      filters: [{ name: 'Supported files', extensions: enabledExtensions() }]
    })
    if (!paths) return { added: [], failed: [], conflicts: [] }
    return knowledgeService.importFiles(sectionId, paths)
  })
  handle('items:import', ({ sectionId, paths, onConflict }) =>
    knowledgeService.importFiles(sectionId, paths, onConflict)
  )

  const resolver = cliResolver
  const messagesRepo = new MessagesRepo(getDb())
  // A crash can leave workers and streaming rows behind; they become stopped before the UI reads them.
  recoverAtStartup({
    db: getDb(),
    workersRepo: new WorkersRepo(getDb()),
    attentionRepo: new AttentionRepo(getDb()),
    messagesRepo,
    eventsRepo: new EventsRepo(getDb()),
    now: Date.now()
  })
  supervisor = new ProcessSupervisor({ ledger: new PidLedger(pidLedgerPath()) })
  const appSettingsRepo = new AppSettingsRepo(getDb())
  appSettingsRef = appSettingsRepo
  const codexProbe = new CodexProbe({
    supervisor,
    binary: resolver.codexBinary(),
    resolvePath: () => resolver.resolvePath(),
    clientVersion: app.getVersion()
  })
  codexCommands = new CodexCommands({
    skills: codexProbe,
    status: () => getProviderStatus().get(),
    log: sessionsLog
  })
  const cursorProbe = new CursorProbe({
    supervisor,
    binary: () => resolver.cursorBinary(),
    resolvePath: () => resolver.resolvePath(),
    dir: join(app.getPath('userData'), 'cursor-probe')
  })
  cursorCommands = new CursorCommands({
    probe: cursorProbe,
    status: () => getProviderStatus().get()
  })
  const models = new ModelRegistry({
    codex: codexProbe,
    cursor: cursorProbe,
    status: () => getProviderStatus().get(),
    cachePath: join(app.getPath('userData'), 'provider-cache.json'),
    log: sessionsLog
  })
  modelRegistry = models
  handle('providers:models', async () => {
    // Before the first check has finished there is no Codex or Cursor status, and no list: wait for that
    // check (it shares the one already running) instead of answering with an empty list.
    const providers = getProviderStatus()
    for (const provider of ['codex', 'cursor'] as const) {
      if (!providers.getStatus(provider))
        await providers.ensureFresh(provider).catch(() => undefined)
    }
    await models.refresh()
    return models.all()
  })
  handle('settings:get', () => appSettingsRepo.getAll())
  handle('settings:set', (patch) => {
    const loadBefore = patch['agents.loadOff'] ? appSettingsRepo.get('agents.loadOff') : undefined
    appSettingsRepo.setMany(
      {
        ...(patch['providers.brain'] ? { 'providers.brain': patch['providers.brain'] } : {}),
        ...(patch['providers.workers'] ? { 'providers.workers': patch['providers.workers'] } : {}),
        ...(patch['usage.checkClaudePlanOnLaunch'] !== undefined
          ? { 'usage.checkClaudePlanOnLaunch': patch['usage.checkClaudePlanOnLaunch'] }
          : {}),
        ...(patch['agents.loadOff'] ? { 'agents.loadOff': patch['agents.loadOff'] } : {})
      },
      Date.now()
    )
    const all = appSettingsRepo.getAll()
    emit('settings:changed', all)
    // Commands run in workers: when the Workers selection changed, the `/` list and the brains' lists follow.
    if (loadBefore && !sameKeys(loadBefore.workers, all['agents.loadOff'].workers)) {
      commandCatalogue.invalidate()
      emit('commands:changed', {})
      void sessionService?.pluginsChanged()
    }
    return all
  })
  const mcpDir = join(app.getPath('userData'), 'mcp')
  // Config files of agents from an earlier run hold dead tokens; none is in use yet.
  rmSync(mcpDir, { recursive: true, force: true })
  const bridge = new BridgeServer({ configDir: mcpDir, log: sessionsLog })
  bridgeServer = bridge
  void bridge.start().catch((e: unknown) => sessionsLog.error('could not start the MCP bridge', e))
  const loadOff = createLoadSelection(() => appSettingsRepo.get('agents.loadOff'))
  const pluginView = new PluginViewService({
    baseDir: join(app.getPath('userData'), 'agent-plugins'),
    listInstalled: createClaudePluginLister({ resolver }),
    off: loadOff,
    log: sessionsLog,
    onChanged: () => emit('commands:changed', {})
  })
  pluginViewService = pluginView
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
  handle('providers:bypass', () => bypassDetector.detect([]))
  const loadCatalogue = new LoadCatalogue({
    projectPaths: () => new ProjectsRepo(getDb()).allPaths(),
    plugins: pluginView,
    codex: {
      ready: async () => {
        // Right after launch the first check may still be running: wait for it instead of answering "not set up".
        const providers = getProviderStatus()
        if (!providers.getStatus('codex'))
          await providers.ensureFresh('codex').catch(() => undefined)
        return providers.getStatus('codex')?.state === 'ok'
      },
      servers: (cwd) => personalConfig.codexMcp(cwd)
    },
    cursor: {
      ready: async () => {
        const providers = getProviderStatus()
        if (!providers.getStatus('cursor'))
          await providers.ensureFresh('cursor').catch(() => undefined)
        return providers.getStatus('cursor')?.state === 'ok'
      }
    },
    knownTools: () => mcpTools.knownTools(),
    log: sessionsLog
  })
  handle('agent-load:get', () => loadCatalogue.list())
  handle('agent-load:codex', () => loadCatalogue.listCodex())
  handle('agent-load:cursor', () => loadCatalogue.listCursor())
  const commandCatalogue = new CommandCatalogue({
    probe: new CommandProbe({
      supervisor,
      binary: resolver.claudeBinary(),
      resolvePath: () => resolver.resolvePath()
    }),
    codex: { list: (cwds, refresh) => codexCommands?.list(cwds, refresh) ?? Promise.resolve([]) },
    cursor: { list: (cwds, refresh) => cursorCommands?.list(cwds, refresh) ?? Promise.resolve([]) },
    getPersonal: (repoPaths) => personalConfig.claude({ repoPaths, role: 'workers' }),
    getViewDir: async (repoPaths, refresh) => {
      // Commands run in workers, so the list comes from the workers' view.
      const dir = await pluginView.current(repoPaths, 'workers')
      return refresh ? pluginView.rebuild() : dir
    },
    log: sessionsLog
  })
  const pluginService = new PluginService({
    resolver,
    log: sessionsLog,
    onProgress: (event) => emit('plugins:progress', event),
    onChanged: async () => {
      // The view's own onChanged pushes commands:changed when its hash moved.
      await pluginView.rebuild()
      commandCatalogue.invalidate()
      emit('plugins:changed', {})
      await sessionService?.pluginsChanged()
    }
  })
  pluginServiceRef = pluginService
  // Built in the background; agents started before it finishes wait for the same build.
  void pluginView.rebuild()
  const git = createGit()
  const sessionGit = createSessionGit(git)
  const mergeGit = createMergeGit(git, sessionGit)
  const sessionProjectsRepo = new SessionProjectsRepo(getDb())
  const mergeQueue = new MergeQueue()
  const pushGit = createPushGit()
  const reviewService = new ReviewService({
    sessionProjectsRepo,
    mergeGit,
    reviewGit: createReviewGit(git),
    pushGit,
    attribution: createAttribution({
      git,
      workersRepo: new WorkersRepo(getDb()),
      commitsRepo: new CommitsRepo(getDb()),
      mergesRepo: new MergesRepo(getDb())
    }),
    marksRepo: new ReviewMarksRepo(getDb()),
    log: sessionsLog
  })
  const notesService = new NotesService({
    notesRepo: new ReviewNotesRepo(getDb()),
    sessionProjectsRepo,
    reviewService,
    log: sessionsLog
  })
  const worktreesRepo = new WorktreesRepo(getDb())
  const workersRepo = new WorkersRepo(getDb())
  const undoService = new UndoService({
    reviewService,
    workersRepo,
    worktreesRepo,
    worktreeGit: createWorktreeGit(git),
    mergeGit,
    git,
    queue: mergeQueue,
    marksRepo: new ReviewMarksRepo(getDb()),
    getWorktreesRoot: () => join(app.getPath('userData'), 'worktrees'),
    log: sessionsLog
  })
  const pushService = new PushService({
    sessionProjectsRepo,
    mergeGit,
    pushGit,
    log: sessionsLog
  })
  const usageRepo = new UsageRepo(getDb())
  const suggestionsRepo = new UsageSuggestionsRepo(getDb())
  const suggestions = new SuggestionService({
    repo: suggestionsRepo,
    fileReads: new FileReadsRepo(getDb()),
    usage: usageRepo,
    agents: (sessionId) => usageRecorder?.snapshot(sessionId, false).agents ?? [],
    models,
    onChanged: (sessionId) => usageRecorder?.suggestionsChanged(sessionId),
    now: Date.now,
    newId: randomUUID,
    log: sessionsLog
  })
  usageRecorder = new UsageRecorder({
    repo: usageRepo,
    suggestions,
    setupRepo: new AgentSetupRepo(getDb()),
    sessionsRepo: new SessionsRepo(getDb()),
    groupsRepo: new GroupsRepo(getDb()),
    workersRepo: new WorkersRepo(getDb()),
    emit: (usage) => emit('usage:session-changed', usage),
    emitChanged: () => emit('usage:changed', {}),
    now: Date.now,
    log: sessionsLog
  })
  const usage = usageRecorder
  handle('usage:get-session', ({ sessionId }) => usage.snapshot(sessionId))
  handle('usage:dismiss-suggestion', ({ id }) => suggestions.dismiss(id))
  const plans = new PlanUsageService({
    repo: new PlanLimitsRepo(getDb()),
    providers: () => getProviderStatus().get(),
    notices: new PlanNotices(new PlanNoticesRepo(getDb())),
    publish: (snapshot) => emit('plan:changed', snapshot),
    log: sessionsLog
  })
  plans.pruneNotices()
  planUsage = plans
  handle('usage:get-report', ({ range }) =>
    buildUsageReport(
      { repo: usageRepo, suggestions: suggestionsRepo, plans: () => plans.meters(), now: Date.now },
      range
    )
  )
  codexLimits = new CodexRateLimitReader({
    source: codexProbe,
    plans,
    status: () => getProviderStatus().get(),
    log: sessionsLog
  })
  codexLimits.start()
  cursorPlan = new CursorPlanReader({
    tier: () => resolver.cursorSubscriptionTier(),
    plans,
    status: () => getProviderStatus().get(),
    log: sessionsLog
  })
  const planTarget = planProbeTarget(process.env, resolver.claudeBinary(), app.isPackaged)
  if (planTarget) {
    claudePlanProbe = new ClaudePlanProbe({
      supervisor,
      binary: planTarget.binary,
      binaryArgs: planTarget.binaryArgs,
      resolvePath: () => resolver.resolvePath(),
      cwd: join(app.getPath('userData'), 'plan-probe'),
      settingsPath: join(app.getPath('userData'), 'plan-probe-settings.json'),
      models,
      plans,
      recorder: usage,
      isEnabled: () => appSettingsRepo.get('usage.checkClaudePlanOnLaunch'),
      isClaudeReady: () => getProviderStatus().getStatus('claude')?.state === 'ok',
      isRateLimitPaused: () => sessionService?.anyRateLimitWaiting('claude') ?? false,
      log: sessionsLog
    })
  }
  handle('plan:get', () => plans.snapshot())
  handle('plan:dismiss-notice', ({ key }) => plans.dismissNotice(key))
  handle('plan:refresh', async () => {
    await Promise.all([codexLimits?.refresh(), cursorPlan?.refresh()])
    return plans.snapshot()
  })
  sessionService = new SessionService({
    usage,
    planUsage: plans,
    plansRepo: new PlansRepo(getDb()),
    workersRepo: new WorkersRepo(getDb()),
    worktreesRepo: new WorktreesRepo(getDb()),
    heldMessagesRepo: new HeldMessagesRepo(getDb()),
    commitsRepo: new CommitsRepo(getDb()),
    attentionRepo: new AttentionRepo(getDb()),
    allowRulesRepo: new AllowRulesRepo(getDb()),
    worktreeGit: createWorktreeGit(git),
    mergesRepo: new MergesRepo(getDb()),
    mergeGit,
    reviewService,
    notesService,
    undoService,
    pushService,
    mergeQueue,
    bridge,
    getWorktreesRoot: () => join(app.getPath('userData'), 'worktrees'),
    sessionsRepo: new SessionsRepo(getDb()),
    brainThreadsRepo: new BrainThreadsRepo(getDb()),
    messagesRepo,
    eventsRepo: new EventsRepo(getDb()),
    groupsRepo: new GroupsRepo(getDb()),
    projectsRepo: new ProjectsRepo(getDb()),
    sessionProjectsRepo,
    sessionGit,
    getKnowledgeRoot,
    getSessionDir: (sessionId) => join(app.getPath('userData'), 'sessions', sessionId),
    getCodexBrainDir: (sessionId) => join(app.getPath('userData'), 'codex-brain', sessionId),
    getPluginViewDir: (repoPaths, role) => pluginView.current(repoPaths, role),
    personal: personalConfig,
    repoSettings: new RepoSettingsWarner(),
    commands: commandCatalogue,
    codexCommands,
    cursorCommands,
    models,
    providers: getProviderStatus(),
    appSettings: appSettingsRepo,
    onSettingsSaved: () => emit('settings:changed', appSettingsRepo.getAll()),
    registry: new AdapterRegistry({
      claude: new ClaudeAdapter({
        supervisor,
        binary: resolver.claudeBinary(),
        resolvePath: () => resolver.resolvePath()
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
        version: () => getProviderStatus().getStatus('cursor')?.version
      })
    }),
    getCliStatus: () => getProviderStatus().getStatus('claude'),
    recheckCli: async () => {
      const providers = getProviderStatus()
      await providers.check('claude')
      const claude = providers.getStatus('claude')
      if (!claude) throw new Error('claude check produced no status')
      return claude
    },
    onSignedOut: () => getProviderStatus().markSignedOut('claude'),
    emit,
    onAttentionChanged: (sessionId, state) => attention?.onAttentionChanged(sessionId, state),
    log: sessionsLog
  })
  const sessions = sessionService
  // A crash can leave a temporary merge working copy behind; git forgets removed ones on prune.
  void sessions.sweepWorktrees().catch((e: unknown) => sessionsLog.warn('worktree sweep failed', e))
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
  const sessionsRepoForAttention = new SessionsRepo(getDb())
  const workersRepoForAttention = new WorkersRepo(getDb())
  attention = new AttentionService({
    sessions,
    attentionRepo: new AttentionRepo(getDb()),
    sessionsRepo: sessionsRepoForAttention,
    workerOf: (id) => workersRepoForAttention.get(id),
    emit,
    onNewRequest: (notice) => notifications.notify(notice)
  })
  const attentionService = attention
  handle('sessions:attention-summary', () => attentionService.summary())
  handle('attention:answer', ({ requestId, ...answer }) =>
    attentionService.answer(requestId, answer)
  )
  handle('sessions:list', ({ groupId }) => sessions.list(groupId))
  handle('sessions:create', ({ groupId, request, mode, workerLimit, brainModel }) =>
    sessions.create(groupId, request, mode, workerLimit, brainModel)
  )
  handle('sessions:open', ({ sessionId }) => sessions.open(sessionId))
  handle('commands:list', ({ sessionId }) => sessions.listCommands(sessionId, false))
  handle('plugins:list', () => pluginService.list())
  handle('plugins:install', ({ name, marketplace }) => pluginService.install(name, marketplace))
  handle('plugins:update', ({ id }) => pluginService.update(id))
  handle('plugins:uninstall', ({ id }) => pluginService.uninstall(id))
  handle('plugins:check-updates', () => pluginService.checkUpdates())
  handle('commands:refresh', ({ sessionId }) => sessions.listCommands(sessionId, true))
  handle('review:get', ({ sessionId }) => sessions.getReview(sessionId))
  handle('review:file', ({ sessionId, projectId, path, source, showAnyway }) =>
    sessions.getReviewFile(sessionId, projectId, path, showAnyway === true, source ?? 'session')
  )
  handle('review:undo-preview', ({ sessionId, projectId, path }) =>
    sessions.undoPreview(sessionId, projectId, path)
  )
  handle('review:undo', ({ sessionId, projectId, path }) =>
    sessions.undoFile(sessionId, projectId, path)
  )
  handle('review:push-preview', ({ sessionId, projectId }) =>
    sessions.pushPreview(sessionId, projectId)
  )
  handle('review:push', ({ sessionId, projectId }) => sessions.pushBranch(sessionId, projectId))
  handle('review:set-reviewed', ({ sessionId, projectId, path, reviewed }) =>
    sessions.setReviewed(sessionId, projectId, path, reviewed)
  )
  handle('review:note-create', (input) => sessions.createNote(input))
  handle('review:note-update', ({ noteId, body }) => sessions.updateNote(noteId, body))
  handle('review:note-delete', ({ noteId }) => sessions.deleteNote(noteId))
  handle('review:send-notes', ({ sessionId }) => sessions.sendReviewNotes(sessionId))
  handle('sessions:resolve-dirty', ({ token, choices }) => sessions.resolveDirty(token, choices))
  handle('sessions:rename', ({ sessionId, name }) => sessions.rename(sessionId, name))
  handle('sessions:set-config', ({ sessionId, ...patch }) => sessions.setConfig(sessionId, patch))
  handle('sessions:remove-allow-rule', ({ sessionId, ruleId }) =>
    sessions.removeAllowRule(sessionId, ruleId)
  )
  handle('sessions:send-message', ({ sessionId, text }) => sessions.sendMessage(sessionId, text))
  handle('sessions:stop-reply', ({ sessionId }) => sessions.stopReply(sessionId))
  handle('sessions:delete', ({ sessionId }) => sessions.delete(sessionId))
  handle('sessions:plan-decision', ({ sessionId, planId, decision, models }) =>
    sessions.decidePlan(sessionId, planId, decision, models)
  )
  handle('workers:get', ({ workerId }) => sessions.workerDetails(workerId))
  handle('workers:open-terminal', ({ workerId }) => sessions.openTerminal(workerId))
  handle('workers:stop', ({ workerId }) => sessions.stopWorker(workerId))
  handle('workers:remove', ({ workerId }) => sessions.removeWorker(workerId))
  handle('workers:step-in', async ({ workerId }) => {
    await sessions.stepInWorker(workerId)
    return { ok: true as const }
  })
  handle('workers:hand-back', async ({ workerId }) => {
    await sessions.handBackWorker(workerId)
    return { ok: true as const }
  })
  handle('workers:send-input', async ({ workerId, text }) => {
    await sessions.sendWorkerInput(workerId, text)
    return { ok: true as const }
  })
  handle('workers:interrupt', ({ workerId }) => sessions.interruptWorker(workerId))
  handle('workers:continue', (request) =>
    'all' in request
      ? sessions.continueAllWorkers(request.sessionId)
      : sessions.continueWorker(request.workerId)
  )
  handle('sessions:dismiss-prompt', ({ sessionId, messageId }) =>
    sessions.dismissPrompt(sessionId, messageId)
  )
  handle('sessions:page', ({ sessionId, kind, beforeId, limit }) =>
    sessions.page(sessionId, kind, beforeId, limit)
  )
}

function pidLedgerPath(): string {
  return join(app.getPath('userData'), 'run', 'pids.json')
}

/** Dev runs show Electron's default Dock icon; packaged builds get the icon from the bundle. */
function setDevDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin' || process.env['HARNESS_E2E'] === '1') return
  const icon = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function start(): void {
  app.setName('Arc')
  nativeTheme.themeSource = 'dark'
  const userDataOverride = process.env['HARNESS_USER_DATA']
  if (userDataOverride) app.setPath('userData', userDataOverride)
  configureLogging()
  registerKnowledgeScheme()

  void app.whenReady().then(async () => {
    if (isSmokeRun(process.argv)) {
      runSmoke({
        openDatabase: () => {
          openAppDatabase()
          return { close: () => database?.close() }
        },
        info: (m) => dbLog.info(m),
        error: (m, e) => dbLog.error(m, e),
        exit: (code) => app.exit(code)
      })
      return
    }
    try {
      openAppDatabase()
    } catch (err: unknown) {
      dbLog.error('failed to open or migrate', err)
      const message = err instanceof Error ? err.message : String(err)
      const backup = err instanceof MigrationError && err.backupPath ? err.backupPath : null
      dialog.showErrorBox(
        'Arc could not start',
        `${message}${backup ? `\n\nYour data was backed up to:\n${backup}` : ''}`
      )
      app.exit(1)
      return
    }

    if (rendererDevUrl()) {
      // Packaged builds get the strict CSP from the built index.html meta tag.
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [buildCsp({ dev: true })]
          }
        })
      })
    }

    dialogs = createDialogs(process.env, (options) => {
      const win = getMainWindow()
      return win
        ? dialog.showOpenDialog(win, options as Electron.OpenDialogOptions)
        : dialog.showOpenDialog(options as Electron.OpenDialogOptions)
    })
    // Before any window loads data: finish or undo storage operations a crash interrupted.
    try {
      await recoverStorage({
        storageRepo: new KnowledgeStorageRepo(getDb()),
        listGroupIds: () => new GroupsRepo(getDb()).list().map((g) => g.id),
        appDataDir: app.getPath('userData'),
        log: knowledgeLog
      })
    } catch (error: unknown) {
      knowledgeLog.error('storage recovery failed', error)
    }
    // Agents an earlier Arc left running (it crashed or was killed) go before any session opens.
    try {
      const swept = await sweepOrphans(pidLedgerPath(), { warn: (m) => sessionsLog.warn(m) })
      if (swept.length > 0) sessionsLog.warn(`stopped ${swept.length} orphaned agent process(es)`)
    } catch (error: unknown) {
      sessionsLog.error('orphan sweep failed', error)
    }
    setDevDockIcon()
    registerHandlers()
    log.info('Arc started')
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        buildAppMenuTemplate({
          isDev: !app.isPackaged,
          appName: app.name,
          openDesignPreview: () => void openDesignPreview()
        })
      )
    )
    const win = createWindow()
    win.webContents.on('did-finish-load', () => {
      const known = providerStatus?.get()
      if (known && Object.keys(known).length > 0) emit('providers:changed', known)
    })
    startProviderCheck()
    win.on('focus', () => {
      recheckProvidersOnFocus()
      codexLimits?.onFocus()
      cursorPlan?.onFocus()
      void availability?.checkOpenGroup()
      rescanKnowledge()
    })
    void availability?.checkAll()
    app.on('activate', () => {
      if (!getMainWindow()) createWindow()
    })
  })

  // Cmd+Q: route through the same handshake by closing the window first.
  app.on('before-quit', (event) => {
    const win = getMainWindow()
    if (!win || closeGate?.isOpen) return
    isQuitting = true
    event.preventDefault()
    win.close()
  })

  app.on('will-quit', (event) => {
    if (shutdownDone) return
    event.preventDefault()
    if (shuttingDown) return
    shuttingDown = true
    const cleanup = (): void => {
      availability?.stop()
      void pluginViewService?.dispose()
      usageRecorder?.dispose()
      codexLimits?.dispose()
      cursorPlan?.dispose()
      void knowledgeWatcher?.dispose()
      database?.close()
    }
    const closeBridge = async (): Promise<void> => {
      // close() revokes every token and deletes its MCP config file.
      await bridgeServer?.close()
      rmSync(join(app.getPath('userData'), 'mcp'), { recursive: true, force: true })
    }
    const run = sessionService
      ? sessionService.shutdown({
          liveCount: () => supervisor?.liveCount ?? 0,
          signalAll: (signal) => supervisor?.killAllSync(signal),
          closeBridge,
          cleanup,
          cancelPluginOps: () => pluginServiceRef?.cancelForQuit() ?? Promise.resolve()
        })
      : Promise.resolve().then(closeBridge).then(cleanup)
    void run
      .catch((error: unknown) => log.error('shutdown failed', error))
      .finally(() => {
        shutdownDone = true
        // Electron ignores a second app.quit() once will-quit was prevented, so leave directly.
        app.exit(0)
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
