import { describe, expect, it } from 'vitest'
import {
  NOTIFICATION_BODY_MAX,
  NotificationService,
  notificationBody
} from '../../../src/main/sessions/notification-service'
import type {
  NotifiableWindow,
  NotificationE2eHook,
  NotificationServiceDeps
} from '../../../src/main/sessions/notification-service'

interface FakeWindow extends NotifiableWindow {
  sent: [string, unknown][]
  loading: boolean
  finishLoad(): void
  calls: string[]
}

function fakeWindow(loading = false): FakeWindow {
  const listeners: (() => void)[] = []
  const w: FakeWindow = {
    sent: [],
    calls: [],
    loading,
    finishLoad: () => {
      w.loading = false
      listeners.splice(0).forEach((l) => l())
    },
    show: () => void w.calls.push('show'),
    focus: () => void w.calls.push('focus'),
    isMinimized: () => false,
    restore: () => void w.calls.push('restore'),
    webContents: {
      isLoading: () => w.loading,
      send: (channel, payload) => void w.sent.push([channel, payload]),
      once: (_event, listener) => void listeners.push(listener)
    }
  }
  return w
}

function rig(opts: { focused?: boolean; supported?: boolean; e2e?: boolean } = {}): {
  service: NotificationService
  shown: { title: string; body: string; click: () => void }[]
  window: { current: FakeWindow; created: boolean }
  e2e: { __e2e?: Partial<NotificationE2eHook> }
  focused: { value: boolean }
} {
  const shown: { title: string; body: string; click: () => void }[] = []
  const window = { current: fakeWindow(), created: false }
  const e2e: { __e2e?: Partial<NotificationE2eHook> } = {}
  const focused = { value: opts.focused ?? false }
  const deps: NotificationServiceDeps = {
    env: opts.e2e ? { HARNESS_E2E: '1' } : {},
    isSupported: () => opts.supported ?? true,
    isAppFocused: () => focused.value,
    create: (options) => {
      const entry = { ...options, click: (): void => undefined }
      shown.push(entry)
      return {
        onClick: (l) => void (entry.click = l),
        show: () => undefined
      }
    },
    ensureWindow: () => ({ window: window.current, created: window.created }),
    target: e2e
  }
  return { service: new NotificationService(deps), shown, window, e2e, focused }
}

const notice = (requestId = 'r1'): Parameters<NotificationService['notify']>[0] => ({
  sessionId: 's1',
  groupId: 'g1',
  requestId,
  from: 'W1 api-retry · via brain',
  text: 'git push origin arc/fix-order-sync'
})

describe('when a notification fires', () => {
  it('shows one when no window is focused', () => {
    const r = rig()
    r.service.notify(notice())
    expect(r.shown).toHaveLength(1)
    expect(r.shown[0]).toMatchObject({
      title: 'Needs attention',
      body: 'W1 api-retry · via brain: git push origin arc/fix-order-sync'
    })
  })

  it('shows none while a window is focused', () => {
    const r = rig({ focused: true })
    r.service.notify(notice())
    expect(r.shown).toHaveLength(0)
  })

  it('shows none when notifications are not supported', () => {
    const r = rig({ supported: false })
    r.service.notify(notice())
    expect(r.shown).toHaveLength(0)
  })

  it('shows one per request id, even when the request is seen again', () => {
    const r = rig()
    r.service.notify(notice('a'))
    r.service.notify(notice('a'))
    r.service.notify(notice('b'))
    expect(r.shown).toHaveLength(2)
  })

  it('does not notify later for a request that arrived while Arc was focused', () => {
    const r = rig({ focused: true })
    r.service.notify(notice())
    r.focused.value = false
    r.service.notify(notice())
    expect(r.shown).toHaveLength(0)
  })

  it('truncates the body to 120 characters', () => {
    const body = notificationBody('Brain', 'x'.repeat(500))
    expect(body).toHaveLength(NOTIFICATION_BODY_MAX)
    expect(body.endsWith('...')).toBe(true)
  })
})

describe('click', () => {
  it('focuses the window and sends session:open-attention', () => {
    const r = rig()
    r.service.notify(notice())
    r.shown[0]?.click()
    expect(r.window.current.calls).toEqual(['show', 'focus'])
    expect(r.window.current.sent).toEqual([
      ['session:open-attention', { sessionId: 's1', groupId: 'g1', requestId: 'r1' }]
    ])
  })

  it('waits for the renderer of a recreated window, then sends once', () => {
    const r = rig()
    r.window.current = fakeWindow(true)
    r.window.created = true
    r.service.notify(notice())
    r.shown[0]?.click()
    expect(r.window.current.sent).toEqual([])
    r.window.current.finishLoad()
    expect(r.window.current.sent).toEqual([
      ['session:open-attention', { sessionId: 's1', groupId: 'g1', requestId: 'r1' }]
    ])
    r.window.current.finishLoad()
    expect(r.window.current.sent).toHaveLength(1)
  })

  it('buffers while an existing window is still loading', () => {
    const r = rig()
    r.window.current = fakeWindow(true)
    r.service.notify(notice())
    r.shown[0]?.click()
    expect(r.window.current.sent).toEqual([])
    r.window.current.finishLoad()
    expect(r.window.current.sent).toHaveLength(1)
  })
})

describe('E2E stub', () => {
  it('records notifications instead of showing them and clicks through the same handler', () => {
    const r = rig({ e2e: true })
    expect(r.e2e.__e2e?.notifications).toEqual([])
    // Focused by the real check, but the hook can force "unfocused".
    r.focused.value = true
    r.service.notify(notice('skipped'))
    expect(r.e2e.__e2e?.notifications).toEqual([])
    r.e2e.__e2e!.forceUnfocused = true
    r.service.notify(notice('r2'))
    expect(r.e2e.__e2e?.notifications).toEqual([
      {
        title: 'Needs attention',
        body: 'W1 api-retry · via brain: git push origin arc/fix-order-sync',
        sessionId: 's1',
        requestId: 'r2'
      }
    ])
    expect(r.shown).toHaveLength(0)
    r.e2e.__e2e?.clickNotification?.(0)
    expect(r.window.current.sent).toEqual([
      ['session:open-attention', { sessionId: 's1', groupId: 'g1', requestId: 'r2' }]
    ])
  })

  it('keeps hooks that are already on __e2e', () => {
    const target: { __e2e?: Partial<NotificationE2eHook> & { other?: number } } = {
      __e2e: { other: 1 }
    }
    new NotificationService({
      env: { HARNESS_E2E: '1' },
      isSupported: () => true,
      isAppFocused: () => false,
      create: () => ({ onClick: () => undefined, show: () => undefined }),
      ensureWindow: () => ({ window: fakeWindow(), created: false }),
      target
    })
    expect(target.__e2e?.other).toBe(1)
    expect(target.__e2e?.notifications).toEqual([])
  })
})
