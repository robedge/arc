import { messageFor } from '../ipc/messages'

/** Lines kept in memory for one worker; older lines are dropped from the front. */
export const MAX_TERMINAL_LINES = 20_000

export const BRAIN_TAB = 'brain'

/** One worker's transcript as lines. The array is mutated in place; `version` is what views watch. */
export class TerminalBuffer {
  lines: string[] = ['']
  version = $state(0)
  /** The history before what is shown was trimmed (by the main process or by the line cap). */
  truncated = $state(false)
  ready = $state(false)
  error = $state<string | null>(null)

  /** Adds text; the last line stays open until a newline arrives. */
  append(text: string): void {
    if (text === '') return
    const parts = text.replace(/\r/g, '').split('\n')
    this.lines[this.lines.length - 1] += parts[0] ?? ''
    for (let i = 1; i < parts.length; i++) this.lines.push(parts[i] ?? '')
    const extra = this.lines.length - MAX_TERMINAL_LINES
    if (extra > 0) {
      this.lines.splice(0, extra)
      this.truncated = true
    }
    this.version++
  }
}

interface Entry {
  buffer: TerminalBuffer
  /** Chunks that arrived before the backlog; applied after it, minus the ones it already holds. */
  early: { seq: number; text: string }[]
  /** Chunks waiting for the next frame. */
  queued: string[]
  baseSeq: number
}

class WorkerTerminalsStore {
  /** Worker ids with an open terminal tab, in the order they were opened. */
  tabs = $state<string[]>([])
  /** `BRAIN_TAB` or a worker id. */
  active = $state<string>(BRAIN_TAB)
  /** The worker whose details dialog is open. */
  detailsId = $state<string | null>(null)

  private entries = new Map<string, Entry>()
  private frame: number | null = null

  bufferFor(workerId: string): TerminalBuffer | undefined {
    return this.entries.get(workerId)?.buffer
  }

  /** Opens (or switches to) the worker's terminal tab. */
  open(workerId: string): void {
    if (!this.tabs.includes(workerId)) {
      this.tabs = [...this.tabs, workerId]
      void this.load(workerId)
    }
    this.active = workerId
  }

  select(tab: string): void {
    this.active = tab
  }

  close(workerId: string): void {
    const wasActive = this.active === workerId
    this.tabs = this.tabs.filter((id) => id !== workerId)
    this.entries.delete(workerId)
    if (wasActive) this.active = BRAIN_TAB
  }

  showDetails(workerId: string): void {
    this.detailsId = workerId
  }

  closeDetails(): void {
    this.detailsId = null
  }

  /** Forgets every tab and buffer (the session changed or closed). */
  reset(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    this.entries.clear()
    this.tabs = []
    this.active = BRAIN_TAB
    this.detailsId = null
  }

  async load(workerId: string): Promise<void> {
    const entry: Entry = { buffer: new TerminalBuffer(), early: [], queued: [], baseSeq: 0 }
    this.entries.set(workerId, entry)
    const res = await window.harness.invoke('workers:open-terminal', { workerId })
    if (this.entries.get(workerId) !== entry) return
    if (!res.ok) {
      entry.buffer.error = messageFor(res.error)
      entry.buffer.ready = true
      return
    }
    entry.baseSeq = res.data.seq
    entry.buffer.truncated = res.data.truncated
    entry.buffer.append(res.data.backlog)
    entry.buffer.ready = true
    const early = entry.early
    entry.early = []
    for (const chunk of early) if (chunk.seq > entry.baseSeq) entry.queued.push(chunk.text)
    this.flush()
  }

  /** `worker:terminal`: chunks at or below the backlog's seq are already in it. */
  apply(e: { workerId: string; seq: number; text: string }): void {
    const entry = this.entries.get(e.workerId)
    if (!entry) return
    if (!entry.buffer.ready) {
      entry.early.push({ seq: e.seq, text: e.text })
      return
    }
    if (e.seq <= entry.baseSeq) return
    entry.baseSeq = e.seq
    entry.queued.push(e.text)
    if (this.frame === null) this.frame = requestAnimationFrame(() => this.flush())
  }

  /** Delivers everything queued, one append per worker. */
  flush(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame)
    this.frame = null
    for (const entry of this.entries.values()) {
      if (entry.queued.length === 0) continue
      const text = entry.queued.join('')
      entry.queued = []
      entry.buffer.append(text)
    }
  }
}

export const workerTerminals = new WorkerTerminalsStore()
