export type AttachmentScope = 'staged' | 'sent'

/** The `arc-attachment:` URL main serves for a file; `thumb` asks for the small version (images only). */
export function attachmentUrl(scope: AttachmentScope, id: string, thumb = false): string {
  return `arc-attachment://${scope}/${id}${thumb ? '?thumb=1' : ''}`
}
