import { ATTACHMENT_KINDS } from '@shared/attachments'
import type { MessageAttachmentView } from '@shared/attachments'
import type { AttachmentRef } from '../agents/agent-adapter'
import { BridgeToolError } from '../bridge/types'
import type { MessageAttachmentsRepo } from '../db/repositories/message-attachments-repo'
import type { MessageAttachmentRow } from '../db/schema'
import { sentAttachmentPath } from './attachment-paths'

/** The most attachment ids one `spawn_worker` or `message_worker` call may name. */
export const WORKER_ATTACHMENTS_MAX = 10

/** How many valid ids an `unknown_attachment` refusal lists, newest first. */
const LISTED_IDS_MAX = 30

/** The part of the attachments repository the worker side needs. */
export type WorkerAttachmentsRepo = Pick<MessageAttachmentsRepo, 'getMany' | 'listForSession'>

export function refOfRow(row: MessageAttachmentRow, sessionDir: string): AttachmentRef {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    mime: row.mime,
    size: row.sizeBytes,
    path: sentAttachmentPath(sessionDir, row.id, row.storedName)
  }
}

export function viewOfRef(
  ref: Pick<AttachmentRef, 'id' | 'name' | 'kind' | 'size'>
): MessageAttachmentView {
  return { id: ref.id, name: ref.name, kind: ref.kind, size: ref.size }
}

/**
 * The refs for the ids the brain named, in that order. An id that is not an attachment of this
 * session is `unknown_attachment`, and the message lists the ids the brain can use.
 */
export function resolveWorkerAttachments(input: {
  repo: WorkerAttachmentsRepo
  sessionDir: string
  sessionId: string
  ids: readonly string[]
}): AttachmentRef[] {
  if (input.ids.length === 0) return []
  const found = input.repo.getMany([...input.ids], input.sessionId)
  const known = new Set(found.map((r) => r.id))
  const unknown = input.ids.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    const valid = input.repo.listForSession(input.sessionId).slice(-LISTED_IDS_MAX).reverse()
    const named = unknown.map((id) => `"${id}"`).join(', ')
    const list =
      valid.length === 0
        ? 'This session has no attachments.'
        : `The ids you can use: ${valid.map((r) => `${r.id} (${r.name})`).join(', ')}.`
    throw new BridgeToolError(
      'unknown_attachment',
      `${named} ${unknown.length === 1 ? 'is not an attachment' : 'are not attachments'} of this session. Use the ids from the "[Attachments for this message]" blocks. ${list}`
    )
  }
  return found.map((r) => refOfRow(r, input.sessionDir))
}

const KINDS: readonly string[] = ATTACHMENT_KINDS

/** `workers.attachments_json`, read defensively: bad JSON or a bad entry is skipped, never thrown. */
export function parseWorkerAttachments(json: string | null): MessageAttachmentView[] {
  if (json === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: MessageAttachmentView[] = []
  for (const entry of parsed as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    if (
      typeof e['id'] === 'string' &&
      typeof e['name'] === 'string' &&
      typeof e['kind'] === 'string' &&
      KINDS.includes(e['kind']) &&
      typeof e['size'] === 'number'
    ) {
      out.push({
        id: e['id'],
        name: e['name'],
        kind: e['kind'] as MessageAttachmentView['kind'],
        size: e['size']
      })
    }
  }
  return out
}

/** The stored list with `added` joined to it by id, earlier entries first; the new JSON text. */
export function mergeWorkerAttachments(
  existing: string | null,
  added: readonly MessageAttachmentView[]
): string {
  const list = parseWorkerAttachments(existing)
  const seen = new Set(list.map((a) => a.id))
  for (const a of added) {
    if (!seen.has(a.id)) {
      seen.add(a.id)
      list.push({ id: a.id, name: a.name, kind: a.kind, size: a.size })
    }
  }
  return JSON.stringify(list)
}
