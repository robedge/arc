import type { AppError } from '../errors'
import type { DiffHunk } from './review'

/**
 * One knowledge suggestion the brain made, as the renderer shows it. `text` is set for a new note,
 * `hunks` for an update (the diff computed when it was suggested). An update's full resulting text is
 * not part of the view.
 */
export interface KnowledgeSuggestionView {
  id: string
  sessionId: string
  kind: 'new' | 'update'
  title: string
  reason: string
  sectionId: string
  /** The section's name when it was suggested. */
  sectionName: string
  target: {
    /** The existing item an update changes; null for a new note. */
    itemId: string | null
    /** The proposed file name of a new note, or the file name of the note an update changes. */
    name: string
    /** `Section/file` of the note an update changes; null for a new note. */
    relPath: string | null
  }
  text?: string
  hunks?: DiffHunk[]
  createdAt: number
}

/** What the user changed before accepting; each falls back to the suggestion's own value. */
export interface KnowledgeSuggestionEdits {
  text?: string
  name?: string
  sectionId?: string
}

/** What Accept created or changed: enough for the confirmation and its Open link. */
export interface AcceptOutcome {
  groupId: string
  sectionId: string
  sectionName: string
  itemId: string
  /** The file name, with extension. */
  name: string
  edited: boolean
}

/** One suggestion's result in an Accept all: what it created or changed, or why it stayed waiting. */
export type AcceptAllItemResult =
  { id: string; outcome: AcceptOutcome } | { id: string; error: AppError }

/** Accept all: one result per suggestion that was waiting, in the order they were applied (oldest first). */
export interface AcceptAllResult {
  results: AcceptAllItemResult[]
}
