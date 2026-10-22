import type { PlanNoticeRow, PlanNoticesRepo } from '../db/repositories/plan-notices-repo'
import type { PlanLimit, PlanNotice } from '../../shared/types/usage'

export type NoticeThreshold = PlanNotice['threshold']

/** Notices whose reset is more than this many days past are deleted. */
export const NOTICE_RETENTION_DAYS = 8

export type PlanNoticesStore = Pick<PlanNoticesRepo, 'claim' | 'dismiss' | 'pending' | 'prune'>

/** The highest threshold the percentage has reached: 95, else 80, else none. */
export function thresholdFor(usedPercent: number): NoticeThreshold | null {
  if (usedPercent >= 95) return 95
  if (usedPercent >= 80) return 80
  return null
}

/** `resetsAt` (epoch seconds) floored to the minute, which absorbs jitter in the reported time. */
export function resetMinute(resetsAt: number | null): number | null {
  return resetsAt === null ? null : Math.floor(resetsAt / 60) * 60
}

export function noticeKey(
  provider: string,
  windowId: string,
  resetsAt: number | null,
  threshold: NoticeThreshold
): string {
  return `${provider}|${windowId}|${resetMinute(resetsAt) ?? 'none'}|${threshold}`
}

/**
 * Raises each plan warning once per limit window and reset period (tech spec 2.6). `plan_notices`
 * holds the claimed keys, so a warning survives restarts and is never raised twice.
 */
export class PlanNotices {
  constructor(
    private readonly store: PlanNoticesStore,
    private readonly now: () => number = Date.now
  ) {}

  /** Claims the highest threshold the limit has crossed; true when that notice is new. */
  observe(limit: Pick<PlanLimit, 'provider' | 'windowId' | 'usedPercent' | 'resetsAt'>): boolean {
    const threshold = thresholdFor(limit.usedPercent)
    if (threshold === null) return false
    return this.store.claim({
      key: noticeKey(limit.provider, limit.windowId, limit.resetsAt, threshold),
      provider: limit.provider,
      window: limit.windowId,
      threshold,
      resetsAt: resetMinute(limit.resetsAt),
      now: this.now()
    })
  }

  /**
   * Undismissed notices that belong to a window's current reset period, in the order they were
   * raised. A notice from an earlier period that was never dismissed does not resurface.
   */
  pending(limits: readonly PlanLimit[]): PlanNotice[] {
    const current = new Map<string, PlanLimit>()
    for (const l of limits) {
      if (l.stale !== true) current.set(`${l.provider}|${l.windowId}|${resetMinute(l.resetsAt)}`, l)
    }
    const notices: PlanNotice[] = []
    for (const row of this.store.pending()) {
      const limit = current.get(`${row.provider}|${row.window}|${row.resetsAt}`)
      if (limit) notices.push(toNotice(row, limit))
    }
    return notices
  }

  dismiss(key: string): void {
    this.store.dismiss(key, this.now())
  }

  /** Deletes notices whose reset is more than 8 days in the past. */
  prune(): number {
    return this.store.prune(Math.floor(this.now() / 1000) - NOTICE_RETENTION_DAYS * 86_400)
  }
}

function toNotice(row: PlanNoticeRow, limit: PlanLimit): PlanNotice {
  return {
    key: row.key,
    provider: row.provider,
    windowId: row.window,
    label: limit.label,
    threshold: row.threshold === 95 ? 95 : 80,
    usedPercent: limit.usedPercent,
    resetsAt: limit.resetsAt
  }
}
