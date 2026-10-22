import { PolicyCategory, classifyAction, type ClassifyContext } from '../../policy/classify'
import type { CursorToolCall } from './cursor-types'

/**
 * Tool calls that completed without a permission request (tech spec 2.4, "Actions that would run
 * without asking"). Cursor asks before commands and MCP calls, but a project deny blocks silently,
 * the user's allow list or `approvalMode` runs silently, and in agent mode edits never ask (spike
 * M1). Each such call is classified with the same classifier the approvals use, so the session can
 * say what was stopped and what got through.
 */

export type CursorBlockedOutcome = 'blocked' | 'ran-unasked' | 'outside-edit'

export interface CursorBlockedNote {
  outcome: CursorBlockedOutcome
  /** The command, or the file path(s) of an edit, for the note. */
  action: string
  /** `execute` for a command, `edit` for a file change. */
  kind: 'execute' | 'edit'
}

/**
 * A command that completed this quickly with no `rawOutput` never ran: spike M1 saw 62 ms from
 * `pending` to `completed` for the denied push, where a real command always carries
 * `rawOutput {exitCode, stdout, stderr}`.
 */
export const BLOCKED_WITHIN_MS = 2000

const ACTION_MAX = 160
const EDIT_KINDS = new Set(['edit', 'delete', 'move'])

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function short(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > ACTION_MAX ? `${oneLine.slice(0, ACTION_MAX - 1)}…` : oneLine
}

function commandOf(call: CursorToolCall): string | undefined {
  return (
    str(call.rawInput['command']) ?? str(/^`([\s\S]+)`$/.exec(call.title.trim())?.[1]) ?? undefined
  )
}

/** Paths an edit names: its locations, its input and the diffs it carries. */
function editPathsOf(call: CursorToolCall): string[] {
  const paths = [...call.locations]
  for (const key of ['path', 'filePath', 'file_path']) {
    const value = str(call.rawInput[key])
    if (value !== undefined) paths.push(value)
  }
  for (const item of call.content) {
    if (typeof item === 'object' && item !== null) {
      const entry = item as Record<string, unknown>
      if (entry['type'] === 'diff') {
        const path = str(entry['path'])
        if (path !== undefined) paths.push(path)
      }
    }
  }
  return [...new Set(paths.filter((p) => p !== ''))]
}

/** True when the edit shows evidence it happened: a diff, or any output. */
function editHappened(call: CursorToolCall): boolean {
  return (
    call.rawOutput !== undefined ||
    call.content.some(
      (c) =>
        typeof c === 'object' && c !== null && (c as Record<string, unknown>)['type'] === 'diff'
    )
  )
}

/**
 * The note for a tool call that completed with no permission request, or `undefined` when there is
 * nothing to say (an ordinary command in the working copy, a read, a call that did ask).
 */
export function classifyUnaskedCall(
  call: CursorToolCall,
  ctx: ClassifyContext
): CursorBlockedNote | undefined {
  if (call.permissionAsked) return undefined
  if (call.status !== 'completed' && call.status !== 'failed') return undefined

  if (call.kind === 'execute') {
    const command = commandOf(call)
    if (command === undefined) return undefined
    const found = classifyAction({ kind: 'bash', command }, ctx)
    if (found.category === null || !found.mustEscalate) return undefined
    const began = call.inProgressAt ?? call.startedAt
    const took = (call.completedAt ?? began) - began
    const refused = call.rawOutput === undefined && took <= BLOCKED_WITHIN_MS
    return { outcome: refused ? 'blocked' : 'ran-unasked', action: short(command), kind: 'execute' }
  }

  if (EDIT_KINDS.has(call.kind)) {
    const paths = editPathsOf(call)
    if (paths.length === 0) return undefined
    const found = classifyAction({ kind: 'edit', tool: 'Edit', paths }, ctx)
    if (found.category !== PolicyCategory.OutsideWorktree) return undefined
    return {
      outcome: editHappened(call) ? 'outside-edit' : 'blocked',
      // the paths as Cursor named them (the classifier's are real paths, `/private/tmp` for `/tmp`)
      action: short(paths.join(', ')),
      kind: 'edit'
    }
  }
  return undefined
}

/** The event-log sentence for a note (`cursor-blocked`). `who` reads "W3 (Cursor)". */
export function cursorBlockedText(who: string, note: CursorBlockedNote): string {
  switch (note.outcome) {
    case 'blocked':
      return note.kind === 'edit'
        ? `${who} was blocked from changing ${note.action} outside its working copy. Rerun this step on a Claude or Codex worker.`
        : `${who} was blocked from running \`${note.action}\`: Cursor can't ask, so Arc blocked it. Rerun this step on a Claude or Codex worker.`
    case 'ran-unasked':
      return `${who} ran \`${note.action}\` without asking: your Cursor settings let it through. See Settings → Providers.`
    case 'outside-edit':
      return `${who} changed ${note.action} outside its working copy.`
  }
}
