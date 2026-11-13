const UNITS = ['B', 'KB', 'MB', 'GB'] as const

/** A file size for people: "512 B", "2 KB", "1.5 MB". */
export function formatBytes(bytes: number): string {
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const text = unit === 0 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  return `${text} ${UNITS[unit]}`
}
