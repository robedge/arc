import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import { HUD_BACKGROUND, isE2eOffscreen, showWindow, withE2eOffscreen } from './window-options'
import { lockDownWindow } from './lockdown'

const displayBounds = (): Rectangle[] => screen.getAllDisplays().map((d) => d.bounds)

let previewWindow: BrowserWindow | null = null

/**
 * The Design Preview: a static second renderer entry. Deliberately no preload (so no
 * `window.harness`), no parent, no close-gate listener, and never registered as the main window.
 * `register.ts` only trusts the main window's top frame, so the preview cannot reach IPC.
 */
export function openDesignPreview(): BrowserWindow {
  if (previewWindow && !previewWindow.isDestroyed()) {
    if (previewWindow.isMinimized()) previewWindow.restore()
    showWindow(previewWindow, process.env)
    if (!isE2eOffscreen(process.env)) previewWindow.focus()
    return previewWindow
  }

  const win = new BrowserWindow(
    withE2eOffscreen(
      {
        width: 1000,
        height: 760,
        minWidth: 720,
        minHeight: 520,
        show: false,
        title: 'Design Preview',
        backgroundColor: HUD_BACKGROUND,
        titleBarStyle: 'default',
        webPreferences: {
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          webSecurity: true
        }
      },
      process.env,
      displayBounds
    )
  )
  previewWindow = win

  const devBase = app.isPackaged ? undefined : process.env['ELECTRON_RENDERER_URL']
  const devUrl = devBase ? `${devBase.replace(/\/$/, '')}/preview.html` : undefined
  const filePath = join(import.meta.dirname, '../renderer/preview.html')
  const ownUrl = devUrl ?? pathToFileURL(filePath).href
  lockDownWindow(win, { exact: ownUrl })

  win.once('ready-to-show', () => showWindow(win, process.env))
  win.on('closed', () => {
    if (previewWindow === win) previewWindow = null
  })

  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(filePath)
  return win
}
