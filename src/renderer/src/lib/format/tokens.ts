/**
 * Short form of a token count: 950, 12.4k, 1.2M.
 *
 * One decimal, and a trailing ".0" is dropped (84000 -> "84k", 1000 -> "1k", 2000000 -> "2M").
 * Rounding never produces "1000k": 999,950 and above become "1M". Anything that is not a
 * finite, non-negative number reads as "0".
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  const whole = Math.round(n)
  if (whole < 1000) return String(whole)
  const kTenths = Math.round(whole / 100)
  if (kTenths < 10000) return `${trim(kTenths)}k`
  return `${trim(Math.round(whole / 100_000))}M`
}

/** Tenths as a decimal string without a trailing ".0": 124 -> "12.4", 840 -> "84". */
function trim(tenths: number): string {
  const text = (tenths / 10).toFixed(1)
  return text.endsWith('.0') ? text.slice(0, -2) : text
}

/** The exact count with locale digit grouping, for hover text: "12,412". */
export function exactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  return Math.round(n).toLocaleString('en-US')
}
