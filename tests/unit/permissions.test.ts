import { describe, expect, it, vi } from 'vitest'
import type { Session, WebContents } from 'electron'
import { decidePermission, installPermissionHandlers } from '../../src/main/app/permissions'
import type { PermissionQuery } from '../../src/main/app/permissions'

const audioRequest: PermissionQuery = {
  kind: 'request',
  permission: 'media',
  mediaTypes: ['audio'],
  isMainWindow: true,
  isOwnPage: true,
  isMainFrame: true
}
const audioCheck: PermissionQuery = {
  kind: 'check',
  permission: 'media',
  mediaType: 'audio',
  isMainWindow: true,
  isOwnPage: true,
  isMainFrame: true
}

describe('decidePermission', () => {
  it('grants audio-only media to the main window on its own page', () => {
    expect(decidePermission(audioRequest)).toBe(true)
    expect(decidePermission(audioCheck)).toBe(true)
  })

  it.each([
    ['video', { mediaTypes: ['video'] }],
    ['audio and video', { mediaTypes: ['audio', 'video'] }],
    ['no media types', { mediaTypes: [] }],
    ['an undeclared media type', { mediaTypes: undefined }]
  ])('denies a media request for %s', (_name, patch) => {
    expect(decidePermission({ ...audioRequest, ...patch })).toBe(false)
  })

  it.each([
    ['video', { mediaType: 'video' }],
    ['no type', { mediaType: undefined }]
  ])('denies a media check for %s', (_name, patch) => {
    expect(decidePermission({ ...audioCheck, ...patch })).toBe(false)
  })

  it('denies the Design Preview even though it shares the origin', () => {
    expect(decidePermission({ ...audioRequest, isMainWindow: false })).toBe(false)
    expect(decidePermission({ ...audioCheck, isMainWindow: false })).toBe(false)
  })

  it('denies a foreign page and a subframe', () => {
    expect(decidePermission({ ...audioRequest, isOwnPage: false })).toBe(false)
    expect(decidePermission({ ...audioRequest, isMainFrame: false })).toBe(false)
  })

  it('grants writing to the clipboard (the Copy buttons) to the main window only', () => {
    const write = { ...audioRequest, permission: 'clipboard-sanitized-write' }
    expect(decidePermission(write)).toBe(true)
    expect(decidePermission({ ...write, kind: 'check' })).toBe(true)
    expect(decidePermission({ ...write, isMainWindow: false })).toBe(false)
    expect(decidePermission({ ...write, isOwnPage: false })).toBe(false)
  })

  it.each([
    'geolocation',
    'notifications',
    'clipboard-read',
    'display-capture',
    'speaker-selection'
  ])('denies %s', (permission) => {
    expect(decidePermission({ ...audioRequest, permission })).toBe(false)
    expect(decidePermission({ ...audioCheck, permission })).toBe(false)
  })
})

type RequestHandler = Parameters<Session['setPermissionRequestHandler']>[0]
type CheckHandler = Parameters<Session['setPermissionCheckHandler']>[0]
type DeviceHandler = Parameters<Session['setDevicePermissionHandler']>[0]

function install(): {
  request: NonNullable<RequestHandler>
  check: NonNullable<CheckHandler>
  device: NonNullable<DeviceHandler>
  main: WebContents
  preview: WebContents
  log: ReturnType<typeof vi.fn>
} {
  const main = { id: 1 } as unknown as WebContents
  const preview = { id: 2 } as unknown as WebContents
  let request: RequestHandler = null
  let check: CheckHandler = null
  let device: DeviceHandler = null
  const ses = {
    setPermissionRequestHandler: (h: RequestHandler) => (request = h),
    setPermissionCheckHandler: (h: CheckHandler) => (check = h),
    setDevicePermissionHandler: (h: DeviceHandler) => (device = h)
  } as unknown as Session
  const log = vi.fn()
  installPermissionHandlers(ses, {
    getMainWebContents: () => main,
    isOwnPage: (url) => url.startsWith('file:///'),
    log
  })
  return {
    request: request as unknown as NonNullable<RequestHandler>,
    check: check as unknown as NonNullable<CheckHandler>,
    device: device as unknown as NonNullable<DeviceHandler>,
    main,
    preview,
    log
  }
}

describe('installPermissionHandlers', () => {
  it('answers a request for the main window and refuses the preview window', () => {
    const h = install()
    const details = {
      requestingUrl: 'file:///app/index.html',
      mediaTypes: ['audio'],
      isMainFrame: true
    }
    const mainAnswer = vi.fn()
    h.request(h.main, 'media', mainAnswer, details as never)
    expect(mainAnswer).toHaveBeenCalledWith(true)
    const previewAnswer = vi.fn()
    h.request(h.preview, 'media', previewAnswer, details as never)
    expect(previewAnswer).toHaveBeenCalledWith(false)
  })

  it('denies a camera request and an unknown permission', () => {
    const h = install()
    const answer = vi.fn()
    h.request(h.main, 'media', answer, {
      requestingUrl: 'file:///app/index.html',
      mediaTypes: ['audio', 'video']
    } as never)
    h.request(h.main, 'geolocation', answer, { requestingUrl: 'file:///app/index.html' } as never)
    expect(answer.mock.calls).toEqual([[false], [false]])
  })

  it('checks by the same rule and denies a check with no web contents', () => {
    const h = install()
    const details = {
      requestingUrl: 'file:///app/index.html',
      mediaType: 'audio',
      isMainFrame: true
    }
    expect(h.check(h.main, 'media', 'file:///', details as never)).toBe(true)
    expect(h.check(h.preview, 'media', 'file:///', details as never)).toBe(false)
    expect(h.check(null, 'media', 'file:///', details as never)).toBe(false)
  })

  it('denies every device permission', () => {
    const h = install()
    expect(h.device({ deviceType: 'hid', origin: 'x', device: {} } as never)).toBe(false)
  })

  it('logs the decision without the page address', () => {
    const h = install()
    h.request(h.main, 'media', () => undefined, {
      requestingUrl: 'file:///Users/someone/secret/index.html',
      mediaTypes: ['audio']
    } as never)
    const text = JSON.stringify(h.log.mock.calls)
    expect(text).toContain('grant')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('file:')
  })
})
