import { asRecord, oneLine } from '../util/json'

/** The longest one-line tool summary a parser shows. */
export const SUMMARY_MAX = 120

/** The longest tool result text a parser keeps. */
export const RESULT_TEXT_MAX = 16_384

/** Text as one line of at most `SUMMARY_MAX` characters. */
export function summaryLine(text: string): string {
  return oneLine(text, SUMMARY_MAX)
}

/** Tool result text cut to `RESULT_TEXT_MAX` characters. */
export function capResultText(text: string): string {
  return text.slice(0, RESULT_TEXT_MAX)
}

/** The first non-blank string argument of an MCP call, as a summary line; empty when there is none. */
export function argsSummary(args: unknown): string {
  for (const value of Object.values(asRecord(args))) {
    if (typeof value === 'string' && value.trim() !== '') return summaryLine(value)
  }
  return ''
}
