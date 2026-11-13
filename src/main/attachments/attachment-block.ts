import type { AttachmentRef } from '../agents/agent-adapter'

/** Bytes, KB or MB, one decimal from 1 KB up. */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** A name is user-controlled: control characters and line separators would break the one-line entry. */
function oneLine(name: string): string {
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim()
}

/**
 * Layer 1 of attachment delivery (tech spec 2.8): the text block every provider gets, whatever the
 * file kind. Empty for no attachments, so a caller can append it only when there is something.
 */
export function attachmentBlock(refs: readonly AttachmentRef[]): string {
  if (refs.length === 0) return ''
  return ['[Attachments for this message]', OPEN_LINE, ...refs.map(entryLine)].join('\n')
}

const OPEN_LINE = 'Open a listed file when the request depends on it; do not guess from its name.'

function entryLine(r: AttachmentRef): string {
  return `- ${r.id} · ${oneLine(r.name)} · ${r.kind} · ${formatAttachmentSize(r.size)} · ${r.path}`
}

/** The most attachments a handoff lists; older ones are counted, not listed. */
export const EARLIER_ATTACHMENTS_MAX = 30

/**
 * The same list for a brain that takes over mid-session (tech spec 2.8, "Handoff to another
 * provider"): `refs` oldest first, the newest {@link EARLIER_ATTACHMENTS_MAX} listed, newest last.
 * Native image blocks are not re-sent; the brain opens a file by its path. Empty for none.
 */
export function earlierAttachmentsBlock(refs: readonly AttachmentRef[]): string {
  if (refs.length === 0) return ''
  const left = Math.max(0, refs.length - EARLIER_ATTACHMENTS_MAX)
  return [
    '[Attachments from earlier in this session]',
    OPEN_LINE,
    ...(left > 0 ? [`(${left} older attachment${left === 1 ? ' is' : 's are'} not listed.)`] : []),
    ...refs.slice(left).map(entryLine)
  ].join('\n')
}

/** The user's text followed by the block, a blank line between; the block alone when there is no text. */
export function withAttachmentBlock(
  text: string,
  refs: readonly AttachmentRef[] | undefined
): string {
  if (!refs || refs.length === 0) return text
  return text === '' ? attachmentBlock(refs) : `${text}\n\n${attachmentBlock(refs)}`
}
