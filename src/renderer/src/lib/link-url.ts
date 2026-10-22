import { messageFor } from './ipc/messages'

/** Client-side address check; the same rule main applies (http/https that `new URL` accepts). */
export function validateLinkUrl(raw: string): string | null {
  try {
    const { protocol } = new URL(raw.trim())
    if (protocol === 'http:' || protocol === 'https:') return null
  } catch {
    // fall through to the message
  }
  return messageFor({ code: 'LINK_URL_INVALID' })
}
