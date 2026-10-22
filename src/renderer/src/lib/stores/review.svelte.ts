import type { AppError } from '@shared/errors'
import type {
  ReviewFile,
  ReviewFileDiff,
  ReviewFileSource,
  ReviewNote,
  ReviewPushPreview,
  ReviewPushResult,
  ReviewRepo,
  ReviewUncommittedFile
} from '@shared/types/review'
import { messageFor } from '../ipc/messages'
import type { SessionMessage } from '@shared/types/session'
import { activeSession } from './active-session.svelte'
import { toasts } from './toasts.svelte'
import type { NoteAnchor } from '../review/note-rows'
import { hunkRowIndexes, toSplitRows, toUnifiedRows } from '../review/diff-rows'

const REFRESH_DEBOUNCE_MS = 300
const NOTICE_MS = 6000
/** The "All repositories" / "All workers" filter value. */
export const ALL = 'all'

export type ReviewLayout = 'unified' | 'split'
const LAYOUT_KEY = 'arc.review.layout'

/** The saved layout; storage that is missing, blocked or holds anything else means unified. */
function readLayout(): ReviewLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'
  } catch {
    return 'unified'
  }
}

/** The line the note composer is open on. */
export interface ComposerTarget extends NoteAnchor {
  projectId: string
  path: string
}

export interface ReviewSelection {
  projectId: string
  /** A path can be in both lists of a repository, so the list is part of the identity. */
  source: ReviewFileSource
  path: string
}

function keyOf(projectId: string, source: ReviewFileSource, path: string): string {
  return `${projectId}\0${source}\0${path}`
}

function signature(f: ReviewUncommittedFile): string {
  return `${f.status}|${f.oldPath ?? ''}|${f.added}|${f.removed}|${f.binary}|${f.large}`
}

class ReviewStore {
  open = $state(false)
  sessionId = $state<string | null>(null)
  repos = $state.raw<ReviewRepo[]>([])
  /** Every worker label in the session (worker order, "You" last): the worker filter options. */
  workers = $state.raw<string[]>([])
  /** Every note of the session, drafts and sent. */
  notes = $state.raw<ReviewNote[]>([])
  /** Where the new-note composer is open; null when closed. */
  composer = $state<ComposerTarget | null>(null)
  private repoValue = $state(ALL)
  private workerValue = $state(ALL)
  selected = $state<ReviewSelection | null>(null)
  loaded = $state(false)
  loading = $state(false)
  loadError = $state<AppError | null>(null)

  /** The selected file's change; null while loading. */
  diff = $state.raw<ReviewFileDiff | null>(null)
  diffError = $state<AppError | null>(null)
  /** "Updated: N more files changed", shown for a few seconds after a live refresh. */
  notice = $state<string | null>(null)
  /** Row to scroll to after n/p; `n` changes on every request. */
  hunkTarget = $state<{ row: number; n: number } | null>(null)

  /** Diff layout; a per-machine preference read once here and written on change. */
  private layoutValue = $state<ReviewLayout>(readLayout())

  private token = 0
  private diffToken = 0
  private hunkIndex = -1
  private targetCount = 0
  /** Large files the user chose to show, by project and path. */
  private shown = new Set<string>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private noticeTimer: ReturnType<typeof setTimeout> | null = null

  /** Project id to show, or `all`. Changing it drops a selection that is no longer listed. */
  get repoFilter(): string {
    return this.repoValue
  }
  set repoFilter(value: string) {
    this.repoValue = value
    this.dropHiddenSelection()
  }

  /** Worker label to show, or `all`. */
  get workerFilter(): string {
    return this.workerValue
  }
  set workerFilter(value: string) {
    this.workerValue = value
    this.dropHiddenSelection()
  }

  get layout(): ReviewLayout {
    return this.layoutValue
  }
  set layout(value: ReviewLayout) {
    this.layoutValue = value
    // A new layout has different row positions.
    this.hunkIndex = -1
    this.hunkTarget = null
    try {
      localStorage.setItem(LAYOUT_KEY, value)
    } catch {
      // Not saved; the choice still holds for this window.
    }
  }

  get isFiltered(): boolean {
    return this.repoValue !== ALL || this.workerValue !== ALL
  }

  /** The repositories and files that match the filters; repositories left empty by a filter are dropped. */
  get visibleRepos(): ReviewRepo[] {
    if (!this.isFiltered) return this.repos
    const allWorkers = this.workerValue === ALL
    return this.repos
      .filter((r) => this.repoValue === ALL || r.projectId === this.repoValue)
      .map((r) => ({
        ...r,
        files: allWorkers ? r.files : r.files.filter((f) => f.workers.includes(this.workerValue)),
        // Uncommitted files have no worker, so any worker filter hides the whole subgroup.
        uncommitted: allWorkers
          ? r.uncommitted
          : { state: 'ok' as const, files: [] as ReviewUncommittedFile[] }
      }))
      .filter(
        (r) => r.files.length > 0 || r.uncommitted.state !== 'ok' || r.uncommitted.files.length > 0
      )
  }

  /** Files shown in list order: what the keyboard moves through. */
  get flatFiles(): ReviewSelection[] {
    return this.visibleRepos.flatMap((r) => [
      ...r.files.map((f) => ({ projectId: r.projectId, source: 'session' as const, path: f.path })),
      ...(r.uncommitted.state === 'ok' ? r.uncommitted.files : []).map((f) => ({
        projectId: r.projectId,
        source: 'uncommitted' as const,
        path: f.path
      }))
    ])
  }

  get selectedFile(): ReviewUncommittedFile | null {
    const sel = this.selected
    if (!sel) return null
    const repo = this.visibleRepos.find((r) => r.projectId === sel.projectId)
    if (!repo) return null
    const files = sel.source === 'session' ? repo.files : this.uncommittedFiles(repo)
    return files.find((f) => f.path === sel.path) ?? null
  }

  private uncommittedFiles(repo: ReviewRepo): ReviewUncommittedFile[] {
    return repo.uncommitted.state === 'ok' ? repo.uncommitted.files : []
  }

  /** The selected session file with its Reviewed state; null for a hand edit or no selection. */
  get selectedSessionFile(): ReviewFile | null {
    const sel = this.selected
    if (!sel || sel.source !== 'session') return null
    return (
      this.repos
        .find((r) => r.projectId === sel.projectId)
        ?.files.find((f) => f.path === sel.path) ?? null
    )
  }

  /** The repository of the selected file. */
  get selectedRepo(): ReviewRepo | null {
    const sel = this.selected
    return sel ? (this.repos.find((r) => r.projectId === sel.projectId) ?? null) : null
  }

  /** Who is still working on a session file, for the Undo warning. */
  async undoPreview(projectId: string, path: string): Promise<string[] | AppError> {
    const sessionId = this.sessionId
    if (sessionId === null) return []
    const res = await window.harness.invoke('review:undo-preview', { sessionId, projectId, path })
    return res.ok ? res.data.activeWorkers : res.error
  }

  /**
   * Puts a session file back. On success the review refreshes and the selection moves to the file now at the
   * same place in the list (or clears); on failure the error is returned.
   */
  async undo(projectId: string, path: string): Promise<AppError | null> {
    const sessionId = this.sessionId
    if (sessionId === null) return null
    const sel = this.selected
    const at = sel
      ? this.flatFiles.findIndex(
          (f) => f.projectId === sel.projectId && f.source === sel.source && f.path === sel.path
        )
      : -1
    const res = await window.harness.invoke('review:undo', { sessionId, projectId, path })
    if (!res.ok) return res.error
    if (sessionId !== this.sessionId) return null
    await this.load()
    if (this.selected === null) {
      const files = this.flatFiles
      const next = files[Math.min(Math.max(at, 0), files.length - 1)]
      if (next) this.select(next.projectId, next.source, next.path)
    }
    return null
  }

  /** The exact command Push branch would run for a repository; nothing is pushed. */
  async pushPreview(projectId: string): Promise<ReviewPushPreview | AppError> {
    const sessionId = this.sessionId
    if (sessionId === null) return { code: 'SESSION_NOT_FOUND' }
    const res = await window.harness.invoke('review:push-preview', { sessionId, projectId })
    return res.ok ? res.data : res.error
  }

  /** Pushes the session branch after the user confirmed in the dialog; refreshes the review on success. */
  async push(projectId: string): Promise<ReviewPushResult | AppError> {
    const sessionId = this.sessionId
    if (sessionId === null) return { code: 'SESSION_NOT_FOUND' }
    const res = await window.harness.invoke('review:push', { sessionId, projectId, confirm: true })
    if (!res.ok) return res.error
    if (sessionId === this.sessionId) await this.load()
    return res.data
  }

  /** Session files ticked as reviewed, over all repositories; filters do not change it. */
  get reviewedCount(): number {
    return this.repos.reduce((sum, repo) => sum + repo.files.filter((f) => f.reviewed).length, 0)
  }

  /** Ticks or unticks a session file. Shown at once; put back with a toast if the main process refuses. */
  async setReviewed(projectId: string, path: string, reviewed: boolean): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === null) return
    const before = this.fileState(projectId, path)
    if (!before) return
    this.patchFile(projectId, path, { reviewed, changedSinceReviewed: false })
    const res = await window.harness.invoke('review:set-reviewed', {
      sessionId,
      projectId,
      path,
      reviewed
    })
    if (sessionId !== this.sessionId) return
    if (!res.ok) {
      this.patchFile(projectId, path, before)
      toasts.show(messageFor(res.error), 'error')
      return
    }
    await this.load()
  }

  private fileState(
    projectId: string,
    path: string
  ): Pick<ReviewFile, 'reviewed' | 'changedSinceReviewed'> | null {
    const f = this.repos.find((r) => r.projectId === projectId)?.files.find((x) => x.path === path)
    return f ? { reviewed: f.reviewed, changedSinceReviewed: f.changedSinceReviewed } : null
  }

  private patchFile(
    projectId: string,
    path: string,
    patch: Pick<ReviewFile, 'reviewed' | 'changedSinceReviewed'>
  ): void {
    this.repos = this.repos.map((r) =>
      r.projectId === projectId
        ? { ...r, files: r.files.map((f) => (f.path === path ? { ...f, ...patch } : f)) }
        : r
    )
  }

  /** Notes not yet sent. */
  get draftCount(): number {
    return this.notes.filter((n) => n.state === 'draft').length
  }

  /** Notes on files that are no longer changed by the session. */
  get goneNotes(): ReviewNote[] {
    return this.notes.filter(
      (n) =>
        !this.repos.some(
          (r) => r.projectId === n.projectId && r.files.some((f) => f.path === n.path)
        )
    )
  }

  /** Counts the local note changes, so a refresh that started before one does not overwrite it. */
  private notesVersion = 0

  private setNotes(notes: ReviewNote[]): void {
    this.notesVersion++
    this.notes = notes
  }

  openComposer(target: ComposerTarget): void {
    this.composer = target
  }

  closeComposer(): void {
    this.composer = null
  }

  /** Saves the open composer's text as a draft; returns the error when the main process refuses. */
  async createNote(body: string): Promise<AppError | null> {
    const sessionId = this.sessionId
    const target = this.composer
    if (sessionId === null || target === null) return null
    const res = await window.harness.invoke('review:note-create', {
      sessionId,
      projectId: target.projectId,
      path: target.path,
      side: target.side,
      line: target.line,
      lineText: target.lineText,
      body
    })
    if (!res.ok) return res.error
    if (sessionId !== this.sessionId) return null
    this.setNotes([...this.notes, res.data])
    this.composer = null
    return null
  }

  async updateNote(noteId: string, body: string): Promise<AppError | null> {
    const res = await window.harness.invoke('review:note-update', { noteId, body })
    if (!res.ok) return res.error
    this.setNotes(this.notes.map((n) => (n.id === noteId ? res.data : n)))
    return null
  }

  async deleteNote(noteId: string): Promise<AppError | null> {
    const res = await window.harness.invoke('review:note-delete', { noteId })
    if (!res.ok) return res.error
    this.setNotes(this.notes.filter((n) => n.id !== noteId))
    return null
  }

  /** Posts every draft to the brain as one message and marks them sent. */
  async sendNotes(): Promise<AppError | null> {
    const sessionId = this.sessionId
    if (sessionId === null) return null
    const res = await window.harness.invoke('review:send-notes', { sessionId })
    if (!res.ok) return res.error
    if (sessionId !== this.sessionId) return null
    const { messageId, count } = res.data
    this.setNotes(
      this.notes.map((n) => (n.state === 'draft' ? { ...n, state: 'sent' as const, messageId } : n))
    )
    await this.showSentMessage(sessionId, messageId)
    toasts.show(`Sent ${count} ${count === 1 ? 'note' : 'notes'} to the brain`, 'success')
    return null
  }

  /** The message the notes were sent in goes into the conversation, which is kept mounted behind the review. */
  private async showSentMessage(sessionId: string, messageId: number): Promise<void> {
    const res = await window.harness.invoke('sessions:page', {
      sessionId,
      kind: 'messages',
      beforeId: messageId + 1,
      limit: 1
    })
    if (!res.ok) return
    const message = (res.data as SessionMessage[]).find((m) => m.id === messageId)
    if (message) activeSession.addUserMessage(message)
  }

  /** Files over all repositories, once loaded. */
  get fileCount(): number {
    return this.repos.reduce((sum, repo) => sum + repo.files.length, 0)
  }

  async openReview(sessionId: string): Promise<void> {
    if (this.sessionId !== sessionId) this.reset()
    this.sessionId = sessionId
    this.open = true
    await this.load()
  }

  /** Back to the session; what was loaded stays for the next open. */
  close(): void {
    this.open = false
  }

  async load(): Promise<void> {
    const sessionId = this.sessionId
    if (sessionId === null) return
    const token = ++this.token
    const notesAtStart = this.notesVersion
    this.loading = true
    this.loadError = null
    const res = await window.harness.invoke('review:get', { sessionId })
    if (token !== this.token) return
    this.loading = false
    if (!res.ok) {
      this.loadError = res.error
      return
    }
    this.repos = res.data.repos
    this.workers = res.data.workers
    // A note saved, edited, deleted or sent while this was in flight is newer than the snapshot, which the
    // main process read before it: the local copy already holds the main process's answer for it.
    if (this.notesVersion === notesAtStart) this.notes = res.data.notes ?? []
    this.loaded = true
    const sel = this.selected
    if (
      sel &&
      !this.repos.some(
        (r) =>
          r.projectId === sel.projectId &&
          (sel.source === 'session' ? r.files : this.uncommittedFiles(r)).some(
            (f) => f.path === sel.path
          )
      )
    ) {
      this.clearSelection()
    }
  }

  select(projectId: string, source: ReviewFileSource, path: string): void {
    const sel = this.selected
    if (sel && sel.projectId === projectId && sel.source === source && sel.path === path) return
    this.selected = { projectId, source, path }
    this.composer = null
    this.diff = null
    this.diffError = null
    this.hunkIndex = -1
    this.hunkTarget = null
    void this.loadDiff()
  }

  /** Arrow, Home, End, `j` and `k` on the file list. */
  moveSelection(move: 'next' | 'prev' | 'first' | 'last'): void {
    const files = this.flatFiles
    if (files.length === 0) return
    const sel = this.selected
    const at = sel
      ? files.findIndex(
          (f) => f.projectId === sel.projectId && f.source === sel.source && f.path === sel.path
        )
      : -1
    let to: number
    if (move === 'first') to = 0
    else if (move === 'last') to = files.length - 1
    else if (move === 'next') to = at < 0 ? 0 : Math.min(files.length - 1, at + 1)
    else to = at < 0 ? files.length - 1 : Math.max(0, at - 1)
    const target = files[to]
    if (target) this.select(target.projectId, target.source, target.path)
  }

  /** `n` and `p`: scroll the diff to the next or previous hunk. */
  stepHunk(direction: 1 | -1): void {
    const diff = this.diff
    if (diff?.kind !== 'text') return
    const rows = hunkRowIndexes(
      this.layoutValue === 'split' ? toSplitRows(diff.hunks) : toUnifiedRows(diff.hunks)
    )
    if (rows.length === 0) return
    const next = Math.min(rows.length - 1, Math.max(0, this.hunkIndex + direction))
    this.hunkIndex = next
    this.hunkTarget = { row: rows[next] as number, n: ++this.targetCount }
  }

  /** Show a large file's text; remembered for the path. */
  showAnyway(): void {
    const sel = this.selected
    if (!sel) return
    this.shown.add(keyOf(sel.projectId, sel.source, sel.path))
    void this.loadDiff()
  }

  async loadDiff(): Promise<void> {
    const sel = this.selected
    const sessionId = this.sessionId
    if (!sel || sessionId === null) return
    const token = ++this.diffToken
    const showAnyway = this.shown.has(keyOf(sel.projectId, sel.source, sel.path))
    const res = await window.harness.invoke('review:file', {
      sessionId,
      projectId: sel.projectId,
      path: sel.path,
      ...(sel.source === 'uncommitted' ? { source: 'uncommitted' as const } : {}),
      ...(showAnyway ? { showAnyway: true } : {})
    })
    if (token !== this.diffToken) return
    if (!res.ok) {
      // A later merge removed the file from the session changes.
      if (res.error.code === 'REVIEW_FILE_NOT_FOUND') this.clearSelection()
      else this.diffError = res.error
      return
    }
    this.diffError = null
    this.diff = res.data
  }

  private dropHiddenSelection(): void {
    const sel = this.selected
    if (
      sel &&
      !this.flatFiles.some(
        (f) => f.projectId === sel.projectId && f.source === sel.source && f.path === sel.path
      )
    ) {
      this.clearSelection()
    }
  }

  private clearSelection(): void {
    this.diffToken++
    this.selected = null
    this.diff = null
    this.diffError = null
    this.hunkIndex = -1
    this.hunkTarget = null
  }

  /**
   * A `session:review-changed` push that the caller already checked against the session and its seq.
   * Waits 300 ms for more pushes, then refreshes the list and, when the open file changed, its diff.
   */
  queueRefresh(e: { sessionId: string; projectId: string; changedPaths: string[] }): void {
    if (!this.loaded || e.sessionId !== this.sessionId) return
    for (const path of e.changedPaths) this.pending.add(keyOf(e.projectId, 'session', path))
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flushRefresh(), REFRESH_DEBOUNCE_MS)
  }

  private async flushRefresh(): Promise<void> {
    this.timer = null
    const changed = this.pending
    this.pending = new Set()
    const before = this.signatures()
    const sel = this.selected
    const selKey = sel ? keyOf(sel.projectId, sel.source, sel.path) : null
    const selBefore = selKey ? before[selKey] : undefined
    await this.load()
    if (this.loadError || !this.loaded) return
    const after = this.signatures()
    let more = 0
    // Only the session's files count for the notice; hand edits are reloaded silently.
    for (const [key, sig] of Object.entries(after)) {
      if (before[key] !== sig && key.split('\0')[1] === 'session') more++
    }
    if (more > 0) this.showNotice(`Updated: ${more} more ${more === 1 ? 'file' : 'files'} changed`)
    if (
      selKey &&
      this.selected &&
      (changed.has(selKey) ||
        after[selKey] !== selBefore ||
        // Hand edits push no event, so the open one is always read again.
        this.selected.source === 'uncommitted')
    ) {
      await this.loadDiff()
    }
  }

  private signatures(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const repo of this.repos) {
      for (const f of repo.files) {
        out[keyOf(repo.projectId, 'session', f.path)] = signature(f)
      }
      for (const f of this.uncommittedFiles(repo)) {
        out[keyOf(repo.projectId, 'uncommitted', f.path)] = signature(f)
      }
    }
    return out
  }

  private showNotice(text: string): void {
    this.notice = text
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = setTimeout(() => {
      this.notice = null
      this.noticeTimer = null
    }, NOTICE_MS)
  }

  /** The active session changed or closed. */
  reset(): void {
    this.token++
    this.diffToken++
    if (this.timer) clearTimeout(this.timer)
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.timer = null
    this.noticeTimer = null
    this.pending = new Set()
    this.shown = new Set()
    this.diff = null
    this.diffError = null
    this.notice = null
    this.hunkTarget = null
    this.hunkIndex = -1
    this.open = false
    this.sessionId = null
    this.repos = []
    this.workers = []
    this.notes = []
    this.composer = null
    this.repoValue = ALL
    this.workerValue = ALL
    this.selected = null
    this.loaded = false
    this.loading = false
    this.loadError = null
  }
}

export const review = new ReviewStore()
