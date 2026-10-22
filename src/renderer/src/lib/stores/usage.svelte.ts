import type {
  SessionUsage,
  Suggestion,
  SpenderKind,
  UsageRange,
  UsageReport
} from '@shared/types/usage'

/** Token usage, with the main process as the source of truth. */
class UsageStore {
  /** Latest snapshot per session id. */
  bySession = $state<Record<string, SessionUsage>>({})

  /** The Usage page's range. */
  range = $state<UsageRange>('7d')

  /** The Usage page's report; null until the first load. */
  report = $state.raw<UsageReport | null>(null)

  /** Which Biggest spenders list shows. */
  spenderKind = $state<SpenderKind>('session')

  /** Counts report requests so a slow answer for an earlier range cannot replace a later one. */
  private reportRequest = 0

  /** Reads one session's usage; the push keeps it current afterwards. */
  async loadSession(sessionId: string): Promise<void> {
    const result = await window.harness.invoke('usage:get-session', { sessionId })
    if (result.ok) this.applySession(result.data)
  }

  /** Replaces the session's snapshot; ignores one older than what is held. */
  applySession(snapshot: SessionUsage): void {
    const held = this.bySession[snapshot.sessionId]
    if (held && held.updatedAt > snapshot.updatedAt) return
    this.bySession = { ...this.bySession, [snapshot.sessionId]: snapshot }
  }

  /** The session's total tokens, or null before the first snapshot. */
  totalFor(sessionId: string): number | null {
    return this.bySession[sessionId]?.total.total ?? null
  }

  /** Switches to `range` and reads its report; an answer that is no longer the latest is dropped. */
  async loadReport(range: UsageRange = this.range): Promise<void> {
    this.range = range
    const request = ++this.reportRequest
    const result = await window.harness.invoke('usage:get-report', { range })
    if (request !== this.reportRequest) return
    if (result.ok) this.report = result.data
  }

  /**
   * Dismisses a suggestion: it leaves every held snapshot and the report at once, and comes back
   * if the main process refuses.
   */
  async dismissSuggestion(id: string): Promise<void> {
    let back: Suggestion | undefined
    const without = (list: Suggestion[]): Suggestion[] =>
      list.filter((s) => {
        if (s.id !== id) return true
        back = s
        return false
      })
    this.bySession = Object.fromEntries(
      Object.entries(this.bySession).map(([key, snap]) => [
        key,
        snap.suggestions.some((s) => s.id === id)
          ? { ...snap, suggestions: without(snap.suggestions) }
          : snap
      ])
    )
    if (this.report?.suggestions.some((s) => s.id === id)) {
      this.report = { ...this.report, suggestions: without(this.report.suggestions) }
    }
    const result = await window.harness.invoke('usage:dismiss-suggestion', { id })
    if (result.ok) return
    const gone = back
    if (!gone) return
    const restore = (list: Suggestion[]): Suggestion[] =>
      list.some((s) => s.id === id)
        ? list
        : [...list, gone].sort((a, b) => b.createdAt - a.createdAt)
    this.bySession = Object.fromEntries(
      Object.entries(this.bySession).map(([key, snap]) => [
        key,
        key === gone.sessionId ? { ...snap, suggestions: restore(snap.suggestions) } : snap
      ])
    )
    if (this.report) this.report = { ...this.report, suggestions: restore(this.report.suggestions) }
  }

  /** `usage:changed`: the held report is out of date, so read it again. */
  handleChanged(): void {
    if (this.report !== null) void this.loadReport(this.range)
  }

  reset(): void {
    this.bySession = {}
    this.range = '7d'
    this.report = null
    this.spenderKind = 'session'
    this.reportRequest++
  }
}

export const usage = new UsageStore()
