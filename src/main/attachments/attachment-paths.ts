import { join } from 'node:path'

/** `<session folder>/attachments`: the folder the brain is later given read-only. */
export function sentAttachmentsRoot(sessionDir: string): string {
  return join(sessionDir, 'attachments')
}

/** The folder of one sent attachment. */
export function sentAttachmentDir(sessionDir: string, attachmentId: string): string {
  return join(sentAttachmentsRoot(sessionDir), attachmentId)
}

/** The only builder of a sent attachment's file path; no path is stored in the database. */
export function sentAttachmentPath(
  sessionDir: string,
  attachmentId: string,
  storedName: string
): string {
  return join(sentAttachmentDir(sessionDir, attachmentId), storedName)
}

/** The thumbnail of an image attachment sits next to the stored file under this name. */
export const THUMB_NAME = 'thumb.png'

/** A stored name that would collide with the thumbnail is kept under another name. */
export function avoidThumbName(storedName: string): string {
  return storedName.toLowerCase() === THUMB_NAME ? `original-${storedName}` : storedName
}

export function sentAttachmentThumbPath(sessionDir: string, attachmentId: string): string {
  return join(sentAttachmentDir(sessionDir, attachmentId), THUMB_NAME)
}
