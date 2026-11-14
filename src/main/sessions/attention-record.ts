import type { AttentionRecordDecision, AttentionRecordPrompt } from '@shared/types/session'
import type { AttentionRequestRow } from '../db/repositories/attention-repo'
import { questionsOfRow } from './attention-questions'
import { requestFrom, toolOfRow } from './attention-service'

/** What the record says the request was about, in full: truncation is the renderer's job. */
export function recordSubject(row: AttentionRequestRow): string {
  if (row.kind === 'question') {
    const questions = questionsOfRow(row)
    const first = questions?.[0]?.question ?? row.question ?? ''
    const more = (questions?.length ?? 0) - 1
    return more > 0 ? `${first} and ${more} more` : first
  }
  const tool = toolOfRow(row)
  if (tool?.kind === 'mcp') return `${tool.server} · ${tool.tool}`
  if (tool?.kind === 'permissions') {
    return tool.reason === '' ? 'more access' : `more access: ${tool.reason}`
  }
  return row.action ?? ''
}

/** The record of a user's answer to a request; `label` is the asking worker's "W1 api-retry". */
export function requestRecord(
  row: AttentionRequestRow,
  label: string,
  decision: AttentionRecordDecision,
  answer?: string
): AttentionRecordPrompt {
  return {
    kind: 'attention-record',
    decision,
    subject: recordSubject(row),
    ...(answer === undefined ? {} : { answer }),
    from: requestFrom(row, label)
  }
}
