import { mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  type Rectangle,
  screen,
  session
} from 'electron'
import { MigrationError, openDatabase, resolveMigrationsFolder } from '../db/client'
import type { Db } from '../db/client'
import { KnowledgeStorageRepo } from '../db/repositories/knowledge-storage-repo'
import { GroupsRepo } from '../db/repositories/groups-repo'
import { recoverStorage } from '../knowledge/storage-recovery'
import { sweepOrphans } from '../agents/pid-ledger'
import { recoverAtStartup } from '../sessions/startup-recovery'
import { SessionsRepo } from '../db/repositories/sessions-repo'
import { WorkersRepo } from '../db/repositories/workers-repo'
import { AttentionRepo } from '../db/repositories/attention-repo'
import { MessagesRepo } from '../db/repositories/messages-repo'
import { EventsRepo } from '../db/repositories/events-repo'
import { emit } from '../ipc/register'
import { registerAllHandlers } from '../ipc/handlers'
import { configureLogging, dbLog, knowledgeLog, log, sessionsLog, voiceLog } from '../logging'
import { createDialogs } from '../platform/dialogs'
import { sweepOrphanAttachmentFolders } from '../attachments/attachment-cleanup'
import { handleAttachmentProtocol } from '../protocol/attachment-protocol'
import { handleKnowledgeProtocol } from '../protocol/knowledge-protocol'
import { handleVoiceModelProtocol } from '../protocol/voice-model-protocol'
import { registerAppSchemes } from '../protocol/schemes'
import { buildCsp } from './csp'
import { installPermissionHandlers } from './permissions'
import { buildServices, pidLedgerPath, startServices } from './build-services'
import type { AppServices } from './app-services'
import { isSmokeRun, runSmoke } from './smoke'
import { createCloseGate } from './close-gate'
import type { CloseGate } from './close-gate'
import { getMainWindow, setMainWindow } from './main-window'
import {
  mainWindowOptions,
  showWindow,
  withE2eOffscreen,
  withWorkAreaBounds
} from './window-options'
import { isOwnNavigation, lockDownWindow } from './lockdown'
import { buildAppMenuTemplate } from './app-menu'
import { openDesignPreview } from './preview-window'

let database: { db: Db; close: () => void } | undefined
let closeGate: CloseGate | undefined
/** Set once startup has built the services; the quit path falls back to closing the database without it. */
let services: AppServices | undefined
let isQuitting = false
let shuttingDown = false
let shutdownDone = false

const CLOSE_FLUSH_TIMEOUT_MS = 2000
/** Logged when the renderer never answered the close handshake (e2e asserts it is absent). */
const CLOSE_GATE_TIMEOUT_MESSAGE = '[close-gate] timed out waiting for the renderer'

function openAppDatabase(): Db {
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
  return opened.db
}

function rendererDevUrl(): string | undefined {
  return !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
}

const displayBounds = (): Rectangle[] => screen.getAllDisplays().map((d) => d.bounds)

function createWindow(): BrowserWindow {
  const win = new BrowserWindow(
    withE2eOffscreen(
      // The primary display, which is where Electron already opens a window with no position.
      withWorkAreaBounds(
        mainWindowOptions(join(import.meta.dirname, '../preload/index.cjs')),
        process.env,
        () => screen.getPrimaryDisplay().workArea
      ),
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
  registerAppSchemes()

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
    let db: Db
    try {
      db = openAppDatabase()
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

    // Audio from the main window only; everything else, the Design Preview included, is denied.
    installPermissionHandlers(session.defaultSession, {
      getMainWebContents: () => getMainWindow()?.webContents ?? null,
      isOwnPage: (url, wc) => {
        const devUrl = rendererDevUrl()
        return isOwnNavigation(url, devUrl ? { origin: devUrl } : { exact: () => wc.getURL() })
      },
      log: (line) => voiceLog.debug(`permission ${line}`)
    })

    const dialogs = createDialogs(process.env, (options) => {
      const win = getMainWindow()
      return win
        ? dialog.showOpenDialog(win, options as Electron.OpenDialogOptions)
        : dialog.showOpenDialog(options as Electron.OpenDialogOptions)
    })
    // Before any window loads data: finish or undo storage operations a crash interrupted.
    try {
      await recoverStorage({
        storageRepo: new KnowledgeStorageRepo(db),
        listGroupIds: () => new GroupsRepo(db).list().map((g) => g.id),
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
    // A crash can leave workers and streaming rows behind; they become stopped before the UI reads them.
    recoverAtStartup({
      db,
      workersRepo: new WorkersRepo(db),
      attentionRepo: new AttentionRepo(db),
      messagesRepo: new MessagesRepo(db),
      eventsRepo: new EventsRepo(db),
      now: Date.now()
    })
    setDevDockIcon()
    const built = buildServices({ db, dialogs, createWindow })
    services = built
    handleKnowledgeProtocol({
      getItem: (id) => built.itemsRepo.getById(id),
      getKnowledgeRoot: built.getKnowledgeRoot,
      log: knowledgeLog
    })
    handleVoiceModelProtocol({
      manifest: built.voiceModels.manifest,
      resolveFile: (model, relPath) => built.voiceModels.readyFilePath(model, relPath),
      log: voiceLog
    })
    const userData = app.getPath('userData')
    handleAttachmentProtocol({
      stagingRoot: join(userData, 'attachment-staging'),
      getStaged: (id) => {
        const s = built.attachments.stagedById(id)
        return s && { ...s.meta, draftId: s.draftId, storedName: s.storedName }
      },
      getSent: (id) => built.messageAttachmentsRepo.get(id),
      getSessionDir: (sessionId) => join(userData, 'sessions', sessionId),
      log: sessionsLog
    })
    registerAllHandlers(built, {
      version: app.getVersion(),
      relaunch: () => {
        app.relaunch()
        app.quit()
      },
      closeReady: () => closeGate?.ready()
    })
    startServices(built)
    // Off the startup path; folders touched in the last minute are skipped, so a send is never raced.
    const sessionsRepo = new SessionsRepo(db)
    void sweepOrphanAttachmentFolders({
      sessionsRoot: join(userData, 'sessions'),
      sessionExists: (id) => sessionsRepo.getById(id) !== undefined,
      knownIds: (sessionId, ids) =>
        built.messageAttachmentsRepo.getMany(ids, sessionId).map((row) => row.id),
      now: Date.now,
      log: sessionsLog
    })
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
      const known = built.providerStatus.get()
      if (Object.keys(known).length > 0) emit('providers:changed', known)
    })
    built.providerChecks.start()
    win.on('focus', () => {
      built.providerChecks.recheckOnFocus()
      built.codexLimits.onFocus()
      built.cursorPlan.onFocus()
      void built.availability.checkOpenGroup()
      // Re-scans the open group's knowledge.
      void built.knowledgeWatcher.rescan()
    })
    void built.availability.checkAll()
    app.on('activate', () => {
      if (!getMainWindow()) createWindow()
    })
  })

  // Cmd+Q: route through the same handshake by closing the window first.
  app.on('before-quit', (event) => {
    // The speech process must not outlive the app, whichever way the quit goes on from here.
    services?.speechHost.dispose()
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
    const closeServices = (): void => {
      if (services) {
        services.availability.stop()
        void services.pluginView.dispose()
        services.usage.dispose()
        services.codexLimits.dispose()
        services.cursorPlan.dispose()
        void services.knowledgeWatcher.dispose()
      }
      database?.close()
    }
    const closeBridge = async (): Promise<void> => {
      // close() revokes every token and deletes its MCP config file.
      await services?.bridge.close()
      rmSync(join(app.getPath('userData'), 'mcp'), { recursive: true, force: true })
    }
    const { supervisor, sessions, pluginService } = services ?? {}
    const run = sessions
      ? sessions.shutdown({
          liveCount: () => supervisor?.liveCount ?? 0,
          signalAll: (signal) => supervisor?.killAllSync(signal),
          closeBridge,
          cleanup: closeServices,
          cancelPluginOps: () => pluginService?.cancelForQuit() ?? Promise.resolve()
        })
      : Promise.resolve().then(closeBridge).then(closeServices)
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
