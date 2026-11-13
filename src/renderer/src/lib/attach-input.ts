import type { StageResult } from '@shared/attachments'
import type { Result } from '@shared/errors'

/** The calls to the staging channels, and what a paste carries. */

export function newDraft(): Promise<Result<{ draftId: string }>> {
  return window.arc.invoke('attachments:new-draft', {})
}

/** Opens the file picker in main and stages what was chosen; a cancelled picker stages nothing. */
export function pickFiles(draftId: string): Promise<Result<StageResult>> {
  return window.arc.invoke('attachments:pick', { draftId })
}

/** Deletes every staged file of a draft that was abandoned (the New Session dialog was cancelled). */
export function discardDraft(draftId: string): Promise<Result<void>> {
  return window.arc.invoke('attachments:discard-draft', { draftId })
}

export function removeStaged(draftId: string, id: string): Promise<Result<void>> {
  return window.arc.invoke('attachments:remove', { draftId, id })
}

export function stagePaths(draftId: string, paths: string[]): Promise<Result<StageResult>> {
  return window.arc.invoke('attachments:stage-paths', { draftId, paths })
}

/** One pasted image; main names it "Pasted image N" and checks the real type from the bytes. */
export function stageBytes(
  draftId: string,
  bytes: Uint8Array<ArrayBuffer>,
  mime: string
): Promise<Result<StageResult>> {
  return window.arc.invoke('attachments:stage-bytes', { draftId, bytes, mime })
}

/**
 * What a paste asks to attach: files with a path, path-less images (screenshots) to read, and
 * path-less files that are not images, which cannot be read and are reported as refused.
 */
export interface PastedFiles {
  paths: string[]
  images: File[]
  unreadable: File[]
}

/**
 * The paste rules. Synchronous on purpose: the handler must read the clipboard and decide whether to
 * prevent the default paste before any await.
 *  1. No files: nothing, the text pastes as usual.
 *  2. A file with a path (copied in Finder): stage it by path.
 *  3. A file with no path (a screenshot): its bytes are staged, one call per image.
 *  4. Every file without a path and plain text on the clipboard too (a spreadsheet copy): text.
 *  5. A file with no path that is not an image cannot be read: it is returned in `unreadable`.
 *  6. The caller prevents the default only when the result is not empty.
 */
export function extractPasted(clipboardData: DataTransfer | null): PastedFiles {
  const none: PastedFiles = { paths: [], images: [], unreadable: [] }
  const files = Array.from(clipboardData?.files ?? [])
  if (!clipboardData || files.length === 0) return none
  const paths: string[] = []
  const withoutPath: File[] = []
  for (const file of files) {
    const path = window.arc.getPathForFile(file)
    if (path !== '') paths.push(path)
    else withoutPath.push(file)
  }
  if (paths.length === 0 && clipboardData.getData('text/plain') !== '') return none
  const isImage = (file: File): boolean => file.type.startsWith('image/')
  return {
    paths,
    images: withoutPath.filter(isImage),
    unreadable: withoutPath.filter((file) => !isImage(file))
  }
}

export function hasPasted(pasted: PastedFiles): boolean {
  return pasted.paths.length > 0 || pasted.images.length > 0 || pasted.unreadable.length > 0
}
