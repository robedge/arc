import type { IconName } from '../ui/icons'
import type { WorkerTone } from './worker-status'

export interface EventStyle {
  icon: IconName
  tone: WorkerTone
  /** Accessible name of the icon, so the kind never relies on colour alone. */
  label: string
}

/** Log kinds the merge flow emits; every other kind renders as a plain row. */
export const EVENT_STYLE: Record<string, EventStyle> = {
  merge: { icon: 'success', tone: 'success', label: 'Merged' },
  'merge-resolved': { icon: 'check', tone: 'success', label: 'Conflict resolved' },
  'merge-conflict': { icon: 'warning', tone: 'attention', label: 'Conflict' },
  'merge-failed': { icon: 'error', tone: 'danger', label: 'Merge failed' },
  'merge-waiting': { icon: 'warning', tone: 'attention', label: 'Update waiting' },
  'allow-rule': { icon: 'check', tone: 'success', label: 'Allow rule added' },
  'auto-approved': { icon: 'check', tone: 'accent', label: 'Auto-approved' },
  'auto-approve': { icon: 'info', tone: 'accent', label: 'Auto-approve changed' },
  undo: { icon: 'info', tone: 'accent', label: 'Undone' },
  push: { icon: 'success', tone: 'success', label: 'Pushed' },
  shared: { icon: 'link', tone: 'accent', label: 'Shared' },
  'repo-settings': { icon: 'info', tone: 'accent', label: 'Repository settings' },
  'cursor-blocked': { icon: 'warning', tone: 'attention', label: 'Blocked' },
  'worktree-kept': { icon: 'info', tone: 'faint', label: 'Working copy kept' }
}

export function eventStyle(kind: string): EventStyle | null {
  return EVENT_STYLE[kind] ?? null
}

export type CursorBlockedOutcome = 'blocked' | 'ran-unasked' | 'outside-edit'

export interface CursorBlockedData {
  outcome: CursorBlockedOutcome
  action: string
  /** Absent in payloads recorded before Cursor edits were told apart; read as a command. */
  kind?: 'execute' | 'edit'
}

/** The `cursor-blocked` payload, or null when the entry carries none (an older log). */
export function parseCursorBlocked(dataJson: string | null | undefined): CursorBlockedData | null {
  if (!dataJson) return null
  try {
    const data = JSON.parse(dataJson) as Partial<CursorBlockedData>
    const outcomes: unknown[] = ['blocked', 'ran-unasked', 'outside-edit']
    if (!outcomes.includes(data.outcome) || typeof data.action !== 'string') return null
    return {
      outcome: data.outcome as CursorBlockedOutcome,
      action: data.action,
      kind: data.kind === 'edit' ? 'edit' : 'execute'
    }
  } catch {
    return null
  }
}

/** What follows the worker chip ("W3") in a `cursor-blocked` row. */
export function cursorBlockedRest(data: CursorBlockedData): string {
  switch (data.outcome) {
    case 'blocked':
      if (data.kind === 'edit')
        return `couldn't change ${data.action}: Arc blocked it. Rerun this step on a Claude or Codex worker.`
      return `couldn't run \`${data.action}\`: Arc blocked it because Cursor can't ask. Rerun this step on a Claude or Codex worker.`
    case 'ran-unasked':
      return `ran \`${data.action}\` without asking (allowed by your Cursor settings).`
    case 'outside-edit':
      return `changed ${data.action} outside its working copy.`
  }
}
