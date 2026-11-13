import type { ProviderId } from './types/provider'

export const ATTACHMENTS_MAX_PER_MESSAGE = 10

export type AttachmentKind = 'image' | 'pdf' | 'text'

export const ATTACHMENT_KINDS: readonly AttachmentKind[] = ['image', 'pdf', 'text']

/**
 * Whether a brain on this provider can read a kind of file natively (spec 012, technical 2.8).
 * Codex and Cursor have no PDF input; the file still reaches them as a path.
 */
export const ATTACHMENT_SUPPORT: Record<ProviderId, Record<AttachmentKind, boolean>> = {
  claude: { image: true, pdf: true, text: true },
  codex: { image: true, pdf: false, text: true },
  cursor: { image: true, pdf: false, text: true }
}

/** The kinds in `kinds` that this provider can't read, each once, in image, PDF, text order. */
export function unreadableKinds(
  provider: ProviderId,
  kinds: Iterable<AttachmentKind | undefined>,
  support: Record<ProviderId, Record<AttachmentKind, boolean>> = ATTACHMENT_SUPPORT
): AttachmentKind[] {
  const present = new Set(kinds)
  return ATTACHMENT_KINDS.filter((kind) => present.has(kind) && !support[provider][kind])
}

export interface AttachmentMeta {
  id: string
  /** The original base name, as the user knows the file. */
  name: string
  kind: AttachmentKind
  mime: string
  size: number
}

/** A sent attachment as the renderer sees it. */
export interface MessageAttachmentView {
  id: string
  name: string
  kind: AttachmentKind
  size: number
}

export type AttachmentRefusalReason =
  'unsupported' | 'too_large' | 'too_many' | 'folder' | 'unreadable'

export interface AttachmentRefusal {
  name: string
  reason: AttachmentRefusalReason
}

export interface StageResult {
  attachments: AttachmentMeta[]
  refused: AttachmentRefusal[]
}
