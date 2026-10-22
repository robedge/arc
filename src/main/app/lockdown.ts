import type { BrowserWindow } from 'electron'

/** The URL a window may stay on: fixed, or resolved at navigation time. */
export type OwnUrl = { exact: string | (() => string) } | { origin: string }

/** True when a navigation target is the window's own page. Pure, so it is unit-tested directly. */
export function isOwnNavigation(url: string, own: OwnUrl): boolean {
  if ('origin' in own) {
    try {
      return new URL(url).origin === new URL(own.origin).origin
    } catch {
      return false
    }
  }
  return url === (typeof own.exact === 'function' ? own.exact() : own.exact)
}

/**
 * Window lockdown: no new windows, no webviews, no navigation away from the window's own page.
 * The main window in dev may navigate within the dev server origin (HMR); the preview is pinned
 * to its exact URL so it can never load the main app.
 */
export function lockDownWindow(win: BrowserWindow, own: OwnUrl): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isOwnNavigation(url, own)) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
}
