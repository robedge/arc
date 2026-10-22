import type { MessagePrompt, SessionMessage } from '@shared/types/session'
import type { MessageRow } from '../db/repositories/messages-repo'

/** Reads the stored `prompt_json` of a message; anything that is not a known prompt is no prompt. */
export function parsePrompt(json: string | null): MessagePrompt | undefined {
  if (json === null) return undefined
  try {
    const parsed = JSON.parse(json) as {
      kind?: unknown
      workerIds?: unknown
      status?: unknown
    } | null
    if (parsed?.kind === 'review-link') return { kind: 'review-link' }
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

export function messageRowDto(row: MessageRow): SessionMessage {
  const prompt = parsePrompt(row.promptJson)
  return {
    id: row.id,
    sessionId: row.sessionId,
    role: row.role,
    content: row.content,
    state: row.state,
    planId: row.planId,
    ...(prompt ? { prompt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}
