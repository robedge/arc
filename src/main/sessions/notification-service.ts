import type { IpcEvents } from '@shared/ipc/contract'
import type { AttentionNotice } from './attention-service'

export const NOTIFICATION_TITLE = 'Needs attention'
export const NOTIFICATION_BODY_MAX = 120

/** A pending notification as `globalThis.__e2e.notifications` records it. */
export interface E2eNotification {
  title: string
  body: string
  sessionId: string
  requestId: string
}

/**
 * E2E hook, installed only when HARNESS_E2E=1 (no real Notification is ever shown):
 * - `notifications`: every notification that would have been shown, in order.
 * - `clickNotification(i)`: runs the click handler of notification `i`.
 * - `forceUnfocused`: set to true to make Arc act as if no window is focused; otherwise the real
 *   focus state of the windows decides.
 */
export interface NotificationE2eHook {
  notifications: E2eNotification[]
  clickNotification(index: number): void
  forceUnfocused: boolean
}

/** The part of the main window a click needs. */
export interface NotifiableWindow {
  show(): void
  focus(): void
  isMinimized(): boolean
  restore(): void
  webContents: {
    isLoading(): boolean
    send(channel: 'session:open-attention', payload: IpcEvents['session:open-attention']): void
    once(event: 'did-finish-load', listener: () => void): void
  }
}

export interface ShownNotification {
  onClick(listener: () => void): void
  show(): void
}

export interface NotificationServiceDeps {
  env: NodeJS.ProcessEnv
  isSupported: () => boolean
  /** True when any Arc window has focus. */
  isAppFocused: () => boolean
  create: (options: { title: string; body: string }) => ShownNotification
  /** The main window, recreated when it was closed; `created` is true for a window just made. */
  ensureWindow: () => { window: NotifiableWindow; created: boolean }
  /** Where `__e2e` goes under HARNESS_E2E=1. */
  target?: { __e2e?: Partial<NotificationE2eHook> }
}

export function notificationBody(from: string, text: string): string {
  const body = `${from}: ${text}`.replace(/\s+/g, ' ').trim()
  return body.length > NOTIFICATION_BODY_MAX
    ? body.slice(0, NOTIFICATION_BODY_MAX - 3) + '...'
    : body
}

/**
 * Shows a macOS notification for a request that reaches the user while Arc is in the background.
 * One notification per request id. A click brings the window forward and tells the renderer to open
 * the request; when the renderer is still loading (a recreated window) the navigation waits for it.
 */
export class NotificationService {
  private readonly notified = new Set<string>()
  private readonly isE2e: boolean
  private readonly hook: NotificationE2eHook | null
  private readonly clickHandlers: (() => void)[] = []
  private pending: IpcEvents['session:open-attention'] | null = null

  constructor(private readonly deps: NotificationServiceDeps) {
    this.isE2e = deps.env['HARNESS_E2E'] === '1'
    if (this.isE2e) {
      const hook: NotificationE2eHook = {
        notifications: [],
        clickNotification: (index) => this.clickHandlers[index]?.(),
        forceUnfocused: false
      }
      const target = deps.target ?? (globalThis as { __e2e?: Partial<NotificationE2eHook> })
      // Merge: other services keep their own hooks on the same object.
      target.__e2e = Object.assign(target.__e2e ?? {}, hook)
      this.hook = target.__e2e as NotificationE2eHook
    } else {
      this.hook = null
    }
  }

  notify(notice: AttentionNotice): void {
    if (this.notified.has(notice.requestId)) return
    this.notified.add(notice.requestId)
    if (this.isFocused()) return
    const title = NOTIFICATION_TITLE
    const body = notificationBody(notice.from, notice.text)
    const open = (): void => this.open(notice.sessionId, notice.groupId, notice.requestId)
    if (this.hook) {
      this.hook.notifications.push({
        title,
        body,
        sessionId: notice.sessionId,
        requestId: notice.requestId
      })
      this.clickHandlers[this.hook.notifications.length - 1] = open
      return
    }
    if (!this.deps.isSupported()) return
    const shown = this.deps.create({ title, body })
    shown.onClick(open)
    shown.show()
  }

  private isFocused(): boolean {
    if (this.hook?.forceUnfocused) return false
    return this.deps.isAppFocused()
  }

  private open(sessionId: string, groupId: string, requestId: string): void {
    const { window, created } = this.deps.ensureWindow()
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
    const payload = { sessionId, groupId, requestId }
    if (created || window.webContents.isLoading()) {
      this.pending = payload
      window.webContents.once('did-finish-load', () => this.flush(window))
      return
    }
    window.webContents.send('session:open-attention', payload)
  }

  private flush(window: NotifiableWindow): void {
    const payload = this.pending
    this.pending = null
    if (payload) window.webContents.send('session:open-attention', payload)
  }
}
