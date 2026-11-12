import { handle } from '../register'

/** What the app-level channels need from the running application. */
export interface AppHost {
  version: string
  /** Queues a relaunch and starts the normal quit path (which routes through the close gate). */
  relaunch(): void
  /** The renderer finished flushing unsaved work for the close handshake. */
  closeReady(): void
}

export function registerAppHandlers(host: AppHost): void {
  handle('app:ping', () => ({ version: host.version }))
  handle('app:close-ready', () => host.closeReady())
  // The quit path stays the existing one (before-quit routes through the close gate), so unsaved work
  // is flushed first; the relaunch is queued before it.
  handle('app:relaunch', () => host.relaunch())
}
