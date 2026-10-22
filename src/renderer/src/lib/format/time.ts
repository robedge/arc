const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** "3:40 PM" when the reset is today, "Mon 3:40 PM" on a later day. `resetsAtSec` is epoch seconds. */
export function formatResetTime(resetsAtSec: number, now: number = Date.now()): string {
  const at = new Date(resetsAtSec * 1000)
  const time = clock.format(at)
  return sameDay(at, new Date(now)) ? time : `${weekday.format(at)} ${time}`
}

/** "as of 2:10 PM". `observedAtMs` is epoch milliseconds. */
export function formatAsOf(observedAtMs: number): string {
  return `as of ${clock.format(new Date(observedAtMs))}`
}
