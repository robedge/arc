/** What to do with the open item when `knowledge:changed` reports a revision for it. */
export type ReconcileAction = 'ignore' | 'replace' | 'conflict' | 'deleted'

export interface ReconcileInput {
  /** The revision the renderer holds (including the one returned by its own last save). */
  held: string
  /** The editor has unsaved changes. */
  dirty: boolean
  /** The revision now on disk; null when the file no longer exists. */
  incoming: string | null
}

/**
 * Decides how the open item reacts to an outside change.
 * Same revision is the app's own write (or a metadata-only change), so the editor is untouched.
 */
export function reconcileOpenItem({ held, dirty, incoming }: ReconcileInput): ReconcileAction {
  if (incoming === null) return 'deleted'
  if (incoming === held) return 'ignore'
  return dirty ? 'conflict' : 'replace'
}
