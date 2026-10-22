const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Short "last active" label such as "just now", "5 min ago" or "2 d ago". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at)
  if (diff < MINUTE) return 'just now'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`
  return `${Math.floor(diff / DAY)} d ago`
}
