import type { Result } from '@shared/errors'
import { messageFor } from '../ipc/messages'

/** Where focus goes once the next push brings the control state: the input line, or the Step in button. */
export type ControlFocus = { workerId: string; target: 'input' | 'step-in' }

/** The user's side of stepping in on workers (spec 006); main stays the source of truth for who is in control. */
class WorkerControlStore {
  /** The unsent input line of each worker, kept while its tab is away. */
  drafts = $state<Record<string, string>>({})
  /** The last failed action of each worker. */
  errors = $state<Record<string, string | null>>({})
  /** Workers with a Step in or Hand back call in flight. */
  busy = $state<Record<string, boolean>>({})
  pendingFocus = $state<ControlFocus | null>(null)

  draftFor(workerId: string): string {
    return this.drafts[workerId] ?? ''
  }

  setDraft(workerId: string, text: string): void {
    this.drafts[workerId] = text
    this.errors[workerId] = null
  }

  private async run(workerId: string, call: () => Promise<Result<unknown>>): Promise<boolean> {
    this.errors[workerId] = null
    const res = await call()
    if (res.ok) return true
    this.errors[workerId] = messageFor(res.error)
    return false
  }

  async stepIn(workerId: string): Promise<boolean> {
    this.busy[workerId] = true
    try {
      const ok = await this.run(workerId, () =>
        window.harness.invoke('workers:step-in', { workerId })
      )
      if (ok) this.pendingFocus = { workerId, target: 'input' }
      return ok
    } finally {
      this.busy[workerId] = false
    }
  }

  async handBack(workerId: string): Promise<boolean> {
    this.busy[workerId] = true
    try {
      const ok = await this.run(workerId, () =>
        window.harness.invoke('workers:hand-back', { workerId })
      )
      if (ok) this.pendingFocus = { workerId, target: 'step-in' }
      return ok
    } finally {
      this.busy[workerId] = false
    }
  }

  /** Sends the line to the worker; the draft is cleared only when the send succeeds. */
  async sendInput(workerId: string, text: string): Promise<boolean> {
    const ok = await this.run(workerId, () =>
      window.harness.invoke('workers:send-input', { workerId, text })
    )
    if (ok) this.drafts[workerId] = ''
    return ok
  }

  async interrupt(workerId: string): Promise<boolean> {
    return this.run(workerId, () => window.harness.invoke('workers:interrupt', { workerId }))
  }

  clearFocus(): void {
    this.pendingFocus = null
  }

  reset(): void {
    this.drafts = {}
    this.errors = {}
    this.busy = {}
    this.pendingFocus = null
  }
}

export const workerControl = new WorkerControlStore()
