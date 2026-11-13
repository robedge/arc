import type { MessagePrompt, SessionMessage } from '@shared/types/session'
import { attachmentView } from '../attachments/attachment-send'
import type { MessageAttachmentRow } from '../db/schema'
import type { MessageRow } from '../db/repositories/messages-repo'

/** Reads the stored `prompt_json` of a message; anything that is not a known prompt is no prompt. */
export function parsePrompt(json: string | null): MessagePrompt | undefined {
  if (json === null) return undefined
  try {
    const parsed = JSON.parse(json) as {
      kind?: unknown
      workerIds?: unknown
      status?: unknown
      count?: unknown
    } | null
    if (parsed?.kind === 'review-link') return { kind: 'review-link' }
    if (
      parsed?.kind === 'knowledge-suggestions' &&
      typeof parsed.count === 'number' &&
      Number.isInteger(parsed.count) &&
      parsed.count > 0
    ) {
      return { kind: 'knowledge-suggestions', count: parsed.count }
    }
    if (
      parsed?.kind === 'continue-workers' &&
      Array.isArray(parsed.workerIds) &&
      (parsed.status === 'open' || parsed.status === 'continued' || parsed.status === 'dismissed')
    ) {
      return {
        kind: 'continue-workers',
        workerIds: parsed.workerIds.filter((x): x is string => typeof x === 'string'),
        status: parsed.status
      }
    }
  } catch {
    // Not JSON: no prompt.
  }
  return undefined
}

/** "2 workers were stopped when Arc closed. Continue them?" */
export function continuePromptText(count: number): string {
  return count === 1
    ? '1 worker was stopped when Arc closed. Continue it?'
    : `${count} workers were stopped when Arc closed. Continue them?`
}

/** "I have 2 suggestions for this group's knowledge." */
export function suggestionsPromptText(count: number): string {
  return `I have ${count} suggestion${count === 1 ? '' : 's'} for this group's knowledge.`
}

export function messageRowDto(
  row: MessageRow,
  attachments?: MessageAttachmentRow[]
): SessionMessage {
  const prompt = parsePrompt(row.promptJson)
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    state: row.state,
    planId: row.planId,
    ...(prompt ? { prompt } : {}),
    ...(attachments && attachments.length > 0
      ? {
          attachments: attachments.map((a) =>
            attachmentView({ id: a.id, name: a.name, kind: a.kind, size: a.sizeBytes })
          )
        }
      : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
