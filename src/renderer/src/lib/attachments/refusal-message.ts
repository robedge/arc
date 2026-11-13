import { ATTACHMENTS_MAX_PER_MESSAGE, type AttachmentRefusal } from '@shared/attachments'
import { IMPORT_MAX_BYTES } from '@shared/limits'
import { formatBytes } from '../format-bytes'

/** The line shown under the message box for one refused file (functional spec 2.2). */
export function refusalMessage(refusal: AttachmentRefusal): string {
  const { name } = refusal
  switch (refusal.reason) {
    case 'unsupported':
      return `${name} can't be attached. Arc accepts images, PDFs and text files.`
    case 'too_large':
      return `${name} is too large. The limit is ${formatBytes(IMPORT_MAX_BYTES)}.`
    case 'too_many':
      return `A message can have at most ${ATTACHMENTS_MAX_PER_MESSAGE} attachments.`
    case 'folder':
      return "Folders can't be attached."
    case 'unreadable':
      return `${name} couldn't be read.`
  }
}
