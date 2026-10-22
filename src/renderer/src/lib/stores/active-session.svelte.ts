import type { AppError } from '@shared/errors'
import type {
  AttentionView,
  BrainState,
  DirtyRepo,
  PlanView,
  ResolveDirtyResult,
  SessionEventEntry,
  SessionHeader,
  SessionMessage,
  SessionSnapshot,
  WorkerView
} from '@shared/types/session'
import { createStreamBuffer } from './stream-buffer'

/** Snapshot window and page size for messages. */
const PAGE_SIZE = 100

function insertSorted(list: SessionMessage[], message: SessionMessage): SessionMessage[] {
  const next = [...list, message]
  next.sort((a, b) => a.id - b.id)
  return next
}

/** The name carried by the last `renamed` entry, or null. */
export function renamedTo(entries: readonly SessionEventEntry[]): string | null {
  let name: string | null = null
  for (const entry of entries) {
    if (entry.kind !== 'renamed' || !entry.dataJson) continue
    try {
      const data: unknown = JSON.parse(entry.dataJson)
      const value = (data as { name?: unknown } | null)?.name
      if (typeof value === 'string' && value !== '') name = value
    } catch {
      // malformed payload: keep the current name
    }
  }
  return name
}

class ActiveSessionStore {
  sessionId = $state<string | null>(null)
  header = $state.raw<SessionHeader | null>(null)
  messages = $state.raw<SessionMessage[]>([])
  events = $state.raw<SessionEventEntry[]>([])
  brainState = $state<BrainState>('idle')
  /** Every plan seen this session, by id (the snapshot carries the latest; pushes add the rest). */
  plans = $state.raw<Record<string, PlanView>>({})
  workers = $state.raw<WorkerView[]>([])
  /** Requests waiting for the user in the open session. */
  attention = $state.raw<AttentionView[]>([])
  /** The attention dialog: null when closed, else the request to show first (if any). */
  attentionDialog = $state<{ initialRequestId: string | null } | null>(null)
  loading = $state(false)
  loadError = $state<AppError | null>(null)
  /** Older messages may exist beyond the loaded window. */
  hasEarlier = $state(false)
  loadingEarlier = $state(false)
  /** Files the session changed, from the snapshot (change review). */
  changedFileCount = $state(0)
  /** Bumped when the user sends, so the conversation scrolls to the bottom. */
  forceBottom = $state(0)
  /** Opening the session needs the user's answer about unsaved changes; nothing is switched until then. */
  dirtyChoice = $state.raw<{ token: string; repos: DirtyRepo[]; message?: string } | null>(null)

  /** Pushes at or below this seq are already part of the snapshot. */
  private baseSeq = 0
  private openToken = 0
  private drafts = new Map<string, string>()
  private buffer = createStreamBuffer((id, text) => this.appendDelta(id, text))

  draftFor(sessionId: string): string {
    return this.drafts.get(sessionId) ?? ''
  }

  setDraft(sessionId: string, text: string): void {
    if (text === '') this.drafts.delete(sessionId)
    else this.drafts.set(sessionId, text)
  }

  async open(sessionId: string): Promise<void> {
    const token = ++this.openToken
    this.buffer.dispose()
    this.sessionId = sessionId
    this.header = null
    this.messages = []
    this.events = []
    this.brainState = 'idle'
    this.plans = {}
    this.workers = []
    this.attention = []
    this.attentionDialog = null
    this.changedFileCount = 0
    this.loading = true
    this.loadError = null
    this.dirtyChoice = null
    const res = await window.harness.invoke('sessions:open', { sessionId })
    if (token !== this.openToken) return
    this.loading = false
    if (!res.ok) this.loadError = res.error
    else if ('needsDirtyChoice' in res.data) {
      // Stay on the list and ask; `resolveDirty` opens the session once the repos are handled.
      this.sessionId = null
      this.dirtyChoice = res.data.needsDirtyChoice
    } else this.setSnapshot(res.data)
  }

  /** The dirty-tree dialog finished (`sessions:resolve-dirty`): open the session, ask again, or stop. */
  resolveDirty(result: ResolveDirtyResult): void {
    if (result.status === 'carry-failed') {
      this.dirtyChoice = { ...result.needsDirtyChoice, message: result.message }
      return
    }
    this.dirtyChoice = null
    // A project that joined an open session already pushed its header; nothing to reopen.
    if (result.status === 'ready' && result.sessionId !== this.sessionId) {
      void this.open(result.sessionId)
    }
  }

  /** `session:dirty-question`: a project joined the group with unsaved changes; ask what to do. */
  applyDirtyQuestion(e: {
    sessionId: string
    needsDirtyChoice: { token: string; repos: DirtyRepo[] }
  }): void {
    this.dirtyChoice = e.needsDirtyChoice
  }

  setSnapshot(snapshot: SessionSnapshot): void {
    this.buffer.dispose()
    this.sessionId = snapshot.header.id
    this.header = snapshot.header
    this.messages = snapshot.messages
    this.events = snapshot.events
    this.brainState = snapshot.brainState
    this.plans = snapshot.plan ? { [snapshot.plan.id]: snapshot.plan } : {}
    this.workers = snapshot.workers
    this.attention = snapshot.attention
    this.changedFileCount = snapshot.changedFileCount
    this.baseSeq = snapshot.seq
    this.hasEarlier = snapshot.messages.length >= PAGE_SIZE
    this.loadingEarlier = false
  }

  /** Prepends the page of messages before the oldest loaded one. */
  async loadEarlier(): Promise<void> {
    const sessionId = this.sessionId
    const oldest = this.messages[0]
    if (sessionId === null || !oldest || this.loadingEarlier) return
    this.loadingEarlier = true
    const res = await window.harness.invoke('sessions:page', {
      sessionId,
      kind: 'messages',
      beforeId: oldest.id,
      limit: PAGE_SIZE
    })
    if (this.sessionId !== sessionId) return
    this.loadingEarlier = false
    if (!res.ok) return
    const rows = res.data as SessionMessage[]
    const seen = new Set(this.messages.map((m) => m.id))
    this.messages = [...rows.filter((m) => !seen.has(m.id)), ...this.messages]
    this.hasEarlier = rows.length >= PAGE_SIZE
  }

  close(): void {
    this.openToken++
    this.buffer.dispose()
    this.dirtyChoice = null
    this.sessionId = null
    this.header = null
    this.messages = []
    this.events = []
    this.brainState = 'idle'
    this.plans = {}
    this.workers = []
    this.attention = []
    this.attentionDialog = null
    this.changedFileCount = 0
    this.loading = false
    this.loadError = null
    this.hasEarlier = false
    this.loadingEarlier = false
  }

  /** Delivers any text still waiting for the next frame. */
  flushStream(): void {
    this.buffer.flush()
  }

  private accepts(sessionId: string, seq: number): boolean {
    return this.sessionId === sessionId && this.header !== null && seq > this.baseSeq
  }

  /** `session:review-changed`: keeps the header's file count current. False when the push is stale or for another session. */
  applyReviewChanged(e: { sessionId: string; seq: number; fileCount: number }): boolean {
    if (!this.accepts(e.sessionId, e.seq)) return false
    this.changedFileCount = e.fileCount
    return true
  }

  applyDelta(e: { sessionId: string; messageId: number; seq: number; text: string }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    this.buffer.push(e.messageId, e.text)
  }

  private appendDelta(messageId: number, text: string): void {
    const sessionId = this.sessionId
    if (sessionId === null) return
    const existing = this.messages.find((m) => m.id === messageId)
    if (existing) {
      this.messages = this.messages.map((m) =>
        m.id === messageId ? { ...m, content: m.content + text, state: 'streaming' } : m
      )
      return
    }
    const now = Date.now()
    this.messages = insertSorted(this.messages, {
      id: messageId,
      sessionId,
      role: 'brain',
      content: text,
      state: 'streaming',
      planId: null,
      createdAt: now,
      updatedAt: now
    })
  }

  applyMessage(e: { sessionId: string; seq: number; message: SessionMessage }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    // Text still queued belongs to the content this message replaces.
    this.buffer.flush()
    const known = this.messages.some((m) => m.id === e.message.id)
    this.messages = known
      ? this.messages.map((m) => (m.id === e.message.id ? e.message : m))
      : insertSorted(this.messages, e.message)
  }

  applyEvents(e: { sessionId: string; seq: number; entries: SessionEventEntry[] }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    const seen = new Set(this.events.map((x) => x.id))
    const fresh = e.entries.filter((x) => !seen.has(x.id))
    if (fresh.length > 0) this.events = [...this.events, ...fresh]
    const name = renamedTo(e.entries)
    if (name !== null) this.setName(name)
  }

  applyBrainState(e: { sessionId: string; seq: number; state: BrainState }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    this.brainState = e.state
  }

  applyHeader(e: { sessionId: string; seq: number; header: SessionHeader }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    this.header = e.header
  }

  applyPlan(e: { sessionId: string; seq: number; plan: PlanView }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    this.plans = { ...this.plans, [e.plan.id]: e.plan }
  }

  applyWorker(e: { sessionId: string; seq: number; worker: WorkerView }): void {
    if (!this.accepts(e.sessionId, e.seq)) return
    const known = this.workers.some((w) => w.id === e.worker.id)
    this.workers = known
      ? this.workers.map((w) => (w.id === e.worker.id ? e.worker : w))
      : [...this.workers, e.worker].sort((a, b) => a.number - b.number)
  }

  /** A removed worker leaves the column at once; the main process has already deleted it. */
  dropWorker(workerId: string): void {
    this.workers = this.workers.filter((w) => w.id !== workerId)
  }

  /** `session:attention` carries no seq (the list is absolute), so it is guarded by session only. */
  applyAttention(e: { sessionId: string; requests: AttentionView[] }): void {
    if (this.sessionId !== e.sessionId || this.header === null) return
    this.attention = e.requests
  }

  /**
   * Requests for Needs attention and its badge: the queue-routed ones, minus any whose worker is under
   * control (the guard for a push that arrives before the control state does).
   */
  get queueAttention(): AttentionView[] {
    return this.attention.filter(
      (r) =>
        r.route === 'queue' &&
        !(r.workerId && this.workers.find((w) => w.id === r.workerId)?.userControl)
    )
  }

  /** The terminal-routed requests of one worker, pinned in its step-in bar. */
  terminalAttentionFor(workerId: string): AttentionView[] {
    return this.attention.filter((r) => r.route === 'terminal' && r.workerId === workerId)
  }

  openAttention(requestId?: string): void {
    this.attentionDialog = { initialRequestId: requestId ?? null }
  }

  closeAttention(): void {
    this.attentionDialog = null
  }

  /** Approve or deny a permission, or answer a question; main pushes the new list. */
  async answerAttention(
    answer:
      | { approve: boolean; always?: boolean }
      | { text: string }
      | { answers: Record<string, string[]> }
      | { decline: true },
    requestId: string
  ): Promise<AppError | null> {
    const res = await window.harness.invoke('attention:answer', { requestId, ...answer })
    return res.ok ? null : res.error
  }

  /** Renames the open session in the header after `sessions:rename` succeeded. */
  setName(name: string): void {
    if (this.header) this.header = { ...this.header, name }
  }

  /** User messages are not pushed; the sender appends them with the returned id. */
  async send(text: string): Promise<AppError | null> {
    const sessionId = this.sessionId
    if (sessionId === null) return null
    const res = await window.harness.invoke('sessions:send-message', { sessionId, text })
    if (!res.ok) return res.error
    if (this.sessionId === sessionId && !this.messages.some((m) => m.id === res.data.messageId)) {
      const now = Date.now()
      this.messages = insertSorted(this.messages, {
        id: res.data.messageId,
        sessionId,
        role: 'user',
        content: text,
        state: 'complete',
        planId: null,
        createdAt: now,
        updatedAt: now
      })
    }
    this.forceBottom++
    return null
  }

  /**
   * Shows a user message another part of the app posted (the review's notes): user messages are not
   * pushed, so whoever sends one adds it.
   */
  addUserMessage(message: SessionMessage): void {
    if (this.sessionId !== message.sessionId || this.messages.some((m) => m.id === message.id)) {
      return
    }
    this.messages = insertSorted(this.messages, message)
    this.forceBottom++
  }

  async stop(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === null) return
    await window.harness.invoke('sessions:stop-reply', { sessionId })
  }
}

export const activeSession = new ActiveSessionStore()
