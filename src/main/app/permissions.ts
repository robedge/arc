import type { Session, WebContents } from 'electron'

export interface PermissionQuery {
  /** A prompt (`request`) names the media types; a check (`check`) names one. */
  kind: 'request' | 'check'
  permission: string
  mediaTypes?: readonly string[] | undefined
  mediaType?: string | undefined
  /** The asking page belongs to the main window (not the Design Preview or anything else). */
  isMainWindow: boolean
  /** The asking page is the app's own page (file:// packaged, the dev server in dev). */
  isOwnPage: boolean
  isMainFrame: boolean
}

/**
 * Only the main window's own top frame may use the microphone, and only audio alone: no camera,
 * no screen, nothing else, apart from writing to the clipboard. The decision rests on which window asks, because the Design Preview is
 * served from the same origin as the app in dev.
 */
export function decidePermission(q: PermissionQuery): boolean {
  if (!q.isMainWindow || !q.isOwnPage || !q.isMainFrame) return false
  // The Copy buttons write to the clipboard. Reading it stays denied.
  if (q.permission === 'clipboard-sanitized-write') return true
  if (q.permission !== 'media') return false
  if (q.kind === 'request') return q.mediaTypes?.length === 1 && q.mediaTypes[0] === 'audio'
  return q.mediaType === 'audio'
}

export interface PermissionDeps {
  getMainWebContents: () => WebContents | null
  /** The app's own page for a window: its current URL when packaged, the dev server origin in dev. */
  isOwnPage: (url: string, webContents: WebContents) => boolean
  /** Permission, media type and verdict only; never a URL. */
  log: (line: string) => void
}

/** Installs the handlers on `ses`; every permission not decided here is denied. */
export function installPermissionHandlers(ses: Session, deps: PermissionDeps): void {
  const verdict = (q: PermissionQuery): boolean => {
    const ok = decidePermission(q)
    deps.log(
      `${q.kind} ${q.permission} ${q.mediaType ?? q.mediaTypes?.join('+') ?? '-'} -> ${ok ? 'grant' : 'deny'}`
    )
    return ok
  }
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const { mediaTypes, requestingUrl, isMainFrame } = details as {
      mediaTypes?: string[]
      requestingUrl?: string
      isMainFrame?: boolean
    }
    callback(
      verdict({
        kind: 'request',
        permission,
        mediaTypes,
        isMainWindow: webContents !== null && webContents === deps.getMainWebContents(),
        isOwnPage: webContents !== null && deps.isOwnPage(requestingUrl ?? '', webContents),
        isMainFrame: isMainFrame !== false
      })
    )
  })
  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const { mediaType, requestingUrl, isMainFrame } = details as {
      mediaType?: string
      requestingUrl?: string
      isMainFrame?: boolean
    }
    return verdict({
      kind: 'check',
      permission,
      mediaType,
      isMainWindow: webContents !== null && webContents === deps.getMainWebContents(),
      isOwnPage: webContents !== null && deps.isOwnPage(requestingUrl ?? '', webContents),
      isMainFrame: isMainFrame !== false
    })
  })
  ses.setDevicePermissionHandler(() => false)
}
