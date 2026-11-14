import { NotificationService } from '../../../src/main/sessions/notification-service'
import type {
  NotifiableWindow,
  NotificationE2eHook
} from '../../../src/main/sessions/notification-service'
import type { AttentionNotice } from '../../../src/main/sessions/attention-service'

export interface NoticeClicks {
  /** Pass to `AttentionService` as `onNewRequest`. */
  notify: (notice: AttentionNotice) => void
  /** Notifications shown so far. */
  count: () => number
  /** Clicks notification `index` and returns the `session:open-attention` payloads sent so far. */
  click: (index: number) => unknown[]
}

/** A real NotificationService (unfocused, e2e hook) over a fake window, to see what a click sends. */
export function noticeClicks(): NoticeClicks {
  const sent: unknown[] = []
  const window: NotifiableWindow = {
    show: () => undefined,
    focus: () => undefined,
    isMinimized: () => false,
    restore: () => undefined,
    webContents: {
      isLoading: () => false,
      send: (_channel, payload) => void sent.push(payload),
      once: () => undefined
    }
  }
  const target: { __e2e?: Partial<NotificationE2eHook> } = {}
  const service = new NotificationService({
    env: { HARNESS_E2E: '1' },
    isSupported: () => true,
    isAppFocused: () => false,
    create: () => ({ onClick: () => undefined, show: () => undefined }),
    ensureWindow: () => ({ window, created: false }),
    target
  })
  return {
    notify: (notice) => service.notify(notice),
    count: () => target.__e2e?.notifications?.length ?? 0,
    click: (index) => {
      target.__e2e?.clickNotification?.(index)
      return sent
    }
  }
}
