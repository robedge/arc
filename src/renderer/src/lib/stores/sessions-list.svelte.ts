import type { SessionSummary } from '@shared/types/session'

class SessionsListStore {
  byGroup = $state.raw<Record<string, SessionSummary[]>>({})

  /** Pending requests that are with the user, per group (all groups, not only loaded ones). */
  attentionByGroup = $state.raw<Record<string, number>>({})
  /** The last count seen per session, to refetch only when a push changes it. */
  private seenCounts = new Map<string, number>()

  hasAttention(groupId: string): boolean {
    return (this.attentionByGroup[groupId] ?? 0) > 0
  }

  /** Startup (and every change): `sessions:attention-summary` is the source of truth. */
  async loadAttention(): Promise<void> {
    const res = await window.harness.invoke('sessions:attention-summary', {})
    if (res.ok) this.attentionByGroup = res.data.byGroup
  }

  /** `session:attention` for ANY session. */
  applyAttention(e: { sessionId: string; count: number }): void {
    this.noteCount(e.sessionId, e.count)
  }

  private noteCount(sessionId: string, count: number): void {
    const known = this.seenCounts.get(sessionId)
    this.seenCounts.set(sessionId, count)
    if (known === count || (known === undefined && count === 0)) return
    void this.loadAttention()
  }

  for(groupId: string | null): SessionSummary[] {
    return groupId === null ? [] : (this.byGroup[groupId] ?? [])
  }

  async load(groupId: string): Promise<void> {
    const res = await window.harness.invoke('sessions:list', { groupId })
    if (res.ok) this.byGroup = { ...this.byGroup, [groupId]: res.data }
  }

  /** Inserts or replaces a summary and keeps the most recently active first. */
  upsert(summary: SessionSummary): void {
    const rest = this.for(summary.groupId).filter((s) => s.id !== summary.id)
    const next = [summary, ...rest].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    this.byGroup = { ...this.byGroup, [summary.groupId]: next }
  }

  /** Drops a deleted session's row. */
  remove(sessionId: string): void {
    for (const [groupId, list] of Object.entries(this.byGroup)) {
      if (!list.some((s) => s.id === sessionId)) continue
      this.byGroup = { ...this.byGroup, [groupId]: list.filter((s) => s.id !== sessionId) }
      return
    }
  }

  /** A `session:summary` push upserts the row in its group and re-sorts newest first. */
  applySummary(e: { groupId: string; summary: SessionSummary }): void {
    this.noteCount(e.summary.id, e.summary.attentionCount)
    // Only groups already loaded are tracked; the list loads fresh when its tab opens.
    if (!(e.groupId in this.byGroup)) return
    this.upsert({ ...e.summary, groupId: e.groupId })
  }

  /** A final message means the session was just active. */
  touch(sessionId: string, at: number): void {
    for (const [groupId, list] of Object.entries(this.byGroup)) {
      if (!list.some((s) => s.id === sessionId)) continue
      const next = list
        .map((s) => (s.id === sessionId ? { ...s, lastActiveAt: Math.max(s.lastActiveAt, at) } : s))
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      this.byGroup = { ...this.byGroup, [groupId]: next }
      return
    }
  }
}

export const sessionsList = new SessionsListStore()
