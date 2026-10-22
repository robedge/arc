import { AppErrorException } from '@shared/errors'
import { isProviderId } from '@shared/provider-label'
import type { PlanView, PlanWorkerView, SessionMessage } from '@shared/types/session'
import type { ModelRef, ProviderId, RunningOn } from '@shared/types/provider'
import { BridgeToolError } from '../bridge/types'
import type { PlanDecisionResult, ProposePlanInput } from '../bridge/types'
import type { MessagesRepo } from '../db/repositories/messages-repo'
import type { PlanRow, PlansRepo } from '../db/repositories/plans-repo'
import { DEFAULT_WORKER_MODEL } from './worker-model'
import type { GatePlan } from './plan-gate'

export type PlanDecision = 'approve' | 'ask-changes' | 'reject'

export interface PlanHost {
  sessionId: string
  now: () => number
  newId: () => string
  /** Pushes `session:plan`. */
  emitPlan: (plan: PlanView) => void
  /** Pushes `session:message` for a message written outside the brain's stream. */
  emitMessage: (message: SessionMessage) => void
  logEvent: (kind: string, text: string, data?: unknown) => void
  /** Called whenever the brain starts or stops being blocked on a plan decision. */
  onWaitingChange?: (waiting: boolean) => void
}

interface Waiter {
  resolve: (result: PlanDecisionResult) => void
  reject: (error: Error) => void
  /** `decision`: waiting for a button. `comment`: "Ask for changes" was clicked; the next chat message is the answer. */
  mode: 'decision' | 'comment'
}

function normalizeProvider(value: unknown): ProviderId {
  return isProviderId(value) ? value : 'claude'
}

/** Reads stored plan workers; a missing or unknown provider becomes `claude`. */
export function parsePlanWorkers(json: string): PlanWorkerView[] {
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return (parsed as PlanWorkerView[]).map((w) => {
      const provider = normalizeProvider(w.provider)
      return {
        ...w,
        provider,
        ...(w.approvedModel !== undefined
          ? { approvedProvider: normalizeProvider(w.approvedProvider ?? provider) }
          : {})
      }
    })
  } catch {
    return []
  }
}

/** What a plan worker will run on: the user's approved choice, else the brain's proposal, else the default. */
function planWorkerRunningOn(w: PlanWorkerView): RunningOn {
  const approved = w.approvedModel !== undefined
  return {
    provider: (approved ? w.approvedProvider : undefined) ?? w.provider ?? 'claude',
    model: (approved ? w.approvedModel : undefined) ?? w.model ?? DEFAULT_WORKER_MODEL
  }
}

export function planView(row: PlanRow): PlanView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    workers: parsePlanWorkers(row.workersJson).map((w) => ({
      ...w,
      runningOn: planWorkerRunningOn(w)
    })),
    messageId: row.messageId,
    replacedById: row.replacedById,
    changesRequested: row.status === 'proposed' && row.resolvedAt !== null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt
  }
}

function planText(workers: readonly PlanWorkerView[]): string {
  const names = workers.map((w) => w.name).join(', ')
  return `Proposed plan: ${workers.length} ${workers.length === 1 ? 'worker' : 'workers'} (${names})`
}

/** Plan proposals and the user's decisions on them (tech spec 2.5). */
export class PlanCoordinator {
  private readonly waiters = new Map<string, Waiter>()
  private wasWaiting = false

  constructor(
    private readonly plansRepo: PlansRepo,
    private readonly messagesRepo: MessagesRepo,
    private readonly host: PlanHost
  ) {}

  latest(): PlanView | null {
    const row = this.plansRepo.latest(this.host.sessionId)
    return row ? planView(row) : null
  }

  approvedPlans(): GatePlan[] {
    return this.plansRepo
      .listBySession(this.host.sessionId)
      .filter((p) => p.status === 'approved')
      .map((p) => ({ id: p.id, status: p.status, workers: parsePlanWorkers(p.workersJson) }))
  }

  /**
   * Stores the plan and its message, pushes it and blocks until the user decides. A plan that was
   * still open (changes requested, or its call died) becomes `replaced`.
   */
  propose(input: ProposePlanInput, signal: AbortSignal): Promise<PlanDecisionResult> {
    const now = this.host.now()
    const workers: PlanWorkerView[] = input.workers.map((w) => ({
      name: w.name.trim(),
      task: w.task,
      repos: w.repos,
      model: w.model?.trim() || null,
      ...(w.provider !== undefined ? { provider: w.provider } : {}),
      rationale: w.rationale,
      ...(w.command?.trim() ? { command: w.command.trim() } : {})
    }))
    const row = this.plansRepo.insert({
      id: this.host.newId(),
      sessionId: this.host.sessionId,
      status: 'proposed',
      workersJson: JSON.stringify(workers),
      messageId: null,
      replacedById: null,
      createdAt: now,
      resolvedAt: null
    })
    for (const old of this.plansRepo.listBySession(this.host.sessionId)) {
      if (old.id === row.id || old.status !== 'proposed') continue
      this.plansRepo.markReplaced(old.id, row.id, now)
      const waiter = this.waiters.get(old.id)
      this.waiters.delete(old.id)
      this.syncWaiting()
      waiter?.resolve({
        planId: old.id,
        decision: 'changes_requested',
        comment: 'Superseded by a newer plan.'
      })
      this.emit(old.id)
    }
    const message = this.messagesRepo.append({
      sessionId: this.host.sessionId,
      role: 'brain',
      content: planText(workers),
      state: 'complete',
      planId: row.id,
      createdAt: now,
      updatedAt: now
    })
    this.plansRepo.setMessageId(row.id, message.id)
    this.host.emitMessage({
      id: message.id,
      sessionId: message.sessionId,
      role: 'brain',
      content: message.content,
      state: 'complete',
      planId: row.id,
      createdAt: now,
      updatedAt: now
    })
    this.emit(row.id)
    this.host.logEvent(
      'plan',
      `Plan proposed: ${workers.length} ${workers.length === 1 ? 'worker' : 'workers'}`,
      {
        planId: row.id
      }
    )

    return new Promise<PlanDecisionResult>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, mode: 'decision' }
      this.waiters.set(row.id, waiter)
      this.syncWaiting()
      signal.addEventListener(
        'abort',
        () => {
          // The call died (timeout, quit, crash): the plan stays proposed and the decision is
          // delivered to the brain as a message instead.
          if (this.waiters.get(row.id) === waiter) {
            this.waiters.delete(row.id)
            this.syncWaiting()
          }
          reject(
            new BridgeToolError('cancelled', 'The call was cancelled before the user decided.')
          )
        },
        { once: true }
      )
    })
  }

  /**
   * Applies the user's decision. Returns true when a waiting `propose_plan` call received it (false
   * means the call is gone and the caller should tell the brain another way).
   */
  decide(planId: string, decision: PlanDecision, models: Record<string, ModelRef> = {}): boolean {
    const row = this.plansRepo.get(planId)
    if (row?.sessionId !== this.host.sessionId) throw new AppErrorException('VALIDATION_FAILED')
    const waiter = this.waiters.get(planId)
    const open = row.status === 'proposed' && row.resolvedAt === null
    if (!open) throw new AppErrorException('VALIDATION_FAILED')
    const now = this.host.now()

    if (decision === 'approve') {
      // The user's pick (provider and model together), else the brain's proposal. A worker with
      // neither stays unapproved and the resolver decides.
      const workers = parsePlanWorkers(row.workersJson).map((w): PlanWorkerView => {
        const pick = models[w.name]
        const model = pick?.model.trim() || w.model || undefined
        if (model === undefined) return w
        return {
          ...w,
          approvedProvider: pick?.provider ?? w.provider ?? 'claude',
          approvedModel: model
        }
      })
      this.plansRepo.setWorkersJson(planId, JSON.stringify(workers))
      this.plansRepo.setStatus(planId, 'approved', now)
      this.waiters.delete(planId)
      this.syncWaiting()
      this.emit(planId)
      this.host.logEvent('plan', 'Plan approved', { planId })
      const resolved: Record<string, string> = {}
      const providers: Record<string, ProviderId> = {}
      for (const w of workers) {
        resolved[w.name] = w.approvedModel ?? DEFAULT_WORKER_MODEL
        providers[w.name] = w.approvedProvider ?? w.provider ?? 'claude'
      }
      waiter?.resolve({ planId, decision: 'approved', models: resolved, providers })
    } else if (decision === 'reject') {
      this.plansRepo.setStatus(planId, 'rejected', now)
      this.waiters.delete(planId)
      this.syncWaiting()
      this.emit(planId)
      this.host.logEvent('plan', 'Plan rejected', { planId })
      waiter?.resolve({ planId, decision: 'rejected' })
    } else {
      this.plansRepo.markChangesRequested(planId, now)
      if (waiter) waiter.mode = 'comment'
      this.emit(planId)
      this.host.logEvent('plan', 'Changes requested on the plan', { planId })
    }
    return waiter !== undefined
  }

  /**
   * The user's next chat message answers a plan the brain is blocked on: the comment after "Ask for
   * changes", or, when the user types without pressing a button, an implicit ask-for-changes (the
   * plan is marked changes-requested and the message is the comment). Returns true when the message
   * was delivered as the tool result (it must not also be sent to the brain as a turn).
   */
  takeComment(text: string): boolean {
    for (const [planId, waiter] of this.waiters) {
      if (waiter.mode === 'decision') {
        this.plansRepo.markChangesRequested(planId, this.host.now())
        this.emit(planId)
        this.host.logEvent('plan', 'Changes requested on the plan', { planId })
      }
      this.waiters.delete(planId)
      this.syncWaiting()
      waiter.resolve({ planId, decision: 'changes_requested', comment: text })
      return true
    }
    return false
  }

  /** Settles every waiting call (shutdown); the plans stay as they are. */
  releaseAll(): void {
    for (const waiter of this.waiters.values()) {
      waiter.reject(new BridgeToolError('shutting_down', 'Arc is shutting down.'))
    }
    this.waiters.clear()
    this.syncWaiting()
  }

  private syncWaiting(): void {
    const waiting = this.waiters.size > 0
    if (waiting === this.wasWaiting) return
    this.wasWaiting = waiting
    this.host.onWaitingChange?.(waiting)
  }

  private emit(planId: string): void {
    const row = this.plansRepo.get(planId)
    if (row) this.host.emitPlan(planView(row))
  }
}
