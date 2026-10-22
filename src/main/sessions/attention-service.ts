import type { AttentionTool, AttentionView } from '@shared/types/session'
import type { IpcEvents } from '@shared/ipc/contract'
import type { AttentionRepo, AttentionRequestRow } from '../db/repositories/attention-repo'
import type { SessionsRepo } from '../db/repositories/sessions-repo'
import type { WorkerRow } from '../db/schema'
import { HELPER_REASON, questionsOfRow } from './attention-questions'
import { CODEX_PERMISSIONS_TOOL } from '../policy/normalized-action'
import { workerLabel } from './worker-label'
import type { AttentionAnswer, AttentionState } from './attention-coordinator'

/** What a notification needs to know about a request that is new for the user. */
export interface AttentionNotice {
  sessionId: string
  /** The session's group, so a click can select it without a lookup. */
  groupId: string
  requestId: string
  /** "W1 api-retry" (escalated by policy), "W1 api-retry · via brain" (passed on by the brain) or "Brain". */
  from: string
  /** The command or the question. */
  text: string
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: unknown[] = value
  return items.every((v) => typeof v === 'string') ? items : undefined
}

/** Server, tool and arguments of a stored `mcp__<server>__<tool>` call; the access of a stored `CodexPermissions` call. */
function toolOfRow(row: AttentionRequestRow): AttentionTool | undefined {
  let input: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(row.toolInputJson ?? '{}')
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>
    }
  } catch {
    // An unreadable input shows as no arguments.
  }
  const name = row.toolName ?? ''
  if (name === CODEX_PERMISSIONS_TOOL) {
    const fs = input['fileSystem']
    const files = typeof fs === 'object' && fs !== null ? (fs as Record<string, unknown>) : {}
    const read = stringList(files['read'])
    const write = stringList(files['write'])
    return {
      kind: 'permissions',
      reason: typeof input['reason'] === 'string' ? input['reason'] : '',
      ...(read ? { read } : {}),
      ...(write ? { write } : {}),
      ...(typeof input['network'] === 'boolean' ? { network: input['network'] } : {})
    }
  }
  // Server names can hold `_`; the server is whatever precedes the first `__` after the prefix.
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) return undefined
  return { kind: 'mcp', server: match[1] ?? '', tool: match[2] ?? '', args: input }
}

/** The renderer-facing shape of a request that is with the user. */
export function attentionView(
  row: AttentionRequestRow,
  worker: Pick<WorkerRow, 'number' | 'slug' | 'dependsOnJson'> | undefined
): AttentionView {
  const label = worker ? workerLabel(worker) : 'A worker'
  // Policy escalations never reached the brain, so only brain-handled requests say "via brain".
  const from = row.source === 'brain' ? 'Brain' : row.mustEscalate ? label : `${label} · via brain`
  // The asking worker, so a WorkerCard can open its own request first.
  const workerId = row.workerId ? { workerId: row.workerId } : {}
  const route = row.route
  if (row.kind === 'question') {
    const questions = questionsOfRow(row)
    return {
      id: row.id,
      route,
      kind: 'question',
      from: row.reason === HELPER_REASON ? `${from} (helper)` : from,
      ...workerId,
      question: row.question ?? '',
      ...(questions ? { questions } : {})
    }
  }
  const tool = toolOfRow(row)
  return {
    id: row.id,
    route,
    kind: 'permission',
    from,
    ...workerId,
    action: row.action ?? '',
    ...(tool ? { tool } : {}),
    ...(row.brainNote ? { reason: row.brainNote } : row.reason ? { reason: row.reason } : {})
  }
}

export function attentionViews(
  rows: AttentionRequestRow[],
  workerOf: (workerId: string) => Pick<WorkerRow, 'number' | 'slug' | 'dependsOnJson'> | undefined
): AttentionView[] {
  return rows.map((row) => attentionView(row, row.workerId ? workerOf(row.workerId) : undefined))
}

export interface AttentionServiceDeps {
  sessions: {
    answerAttention: (requestId: string, answer: AttentionAnswer) => void
  }
  attentionRepo: Pick<AttentionRepo, 'countPendingEscalatedByGroup'>
  sessionsRepo: Pick<SessionsRepo, 'getById'>
  workerOf: (workerId: string) => Pick<WorkerRow, 'number' | 'slug' | 'dependsOnJson'> | undefined
  emit: <E extends 'session:attention'>(event: E, payload: IpcEvents[E]) => void
  /** A request is with the user (called on every change; the notification service dedupes by id). */
  onNewRequest: (notice: AttentionNotice) => void
}

/**
 * Turns the orchestrators' "the set of requests waiting for the user changed" signal into the
 * `session:attention` push and notifications, and serves `attention:answer` and
 * `sessions:attention-summary`. Counts on `SessionSummary` and the list badge come from the session
 * service, which re-derives them on the same signal.
 */
export class AttentionService {
  constructor(private readonly deps: AttentionServiceDeps) {}

  onAttentionChanged(sessionId: string, state: AttentionState): void {
    const session = this.deps.sessionsRepo.getById(sessionId)
    if (!session) return
    const requests = attentionViews(state.requests, this.deps.workerOf)
    this.deps.emit('session:attention', {
      sessionId,
      groupId: session.groupId,
      count: state.count,
      requests
    })
    for (const request of requests) {
      // A request answered in the worker's terminal is not a Needs-attention item: no notification.
      if (request.route === 'terminal') continue
      this.deps.onNewRequest({
        sessionId,
        groupId: session.groupId,
        requestId: request.id,
        from: request.from,
        text: request.kind === 'question' ? request.question : request.action
      })
    }
  }

  answer(requestId: string, answer: AttentionAnswer): void {
    this.deps.sessions.answerAttention(requestId, answer)
  }

  summary(): { byGroup: Record<string, number> } {
    return { byGroup: this.deps.attentionRepo.countPendingEscalatedByGroup() }
  }
}
