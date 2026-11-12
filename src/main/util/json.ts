import { readFile } from 'node:fs/promises'

/** The one method the config readers need from the app's logger. */
export interface ConfigLog {
  warn: (message: string, ...rest: unknown[]) => void
}

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The value when it is a plain object, else an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

/** The value when it is a plain object, else `undefined`. */
export function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** The value when it is a non-empty string, else `undefined`. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** The value when it holds something other than whitespace, else `undefined`. The text is not trimmed. */
export function nonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** The strings of an array, in order; anything else gives an empty array. */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Collapses whitespace to single spaces and cuts the text to `max` characters, ending in an ellipsis when it was cut. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Reads and parses a JSON file. A missing file gives `undefined` quietly; an unreadable or
 * malformed one gives `undefined` too, but with a warning that names the file and the reason
 * (never the contents: config files can hold tokens).
 */
export async function readJsonFile(path: string, log?: ConfigLog): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') log?.warn(`could not read ${path} (${code ?? 'unknown error'})`)
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    log?.warn(`${path} is not valid JSON; treated as empty`)
    return undefined
  }
}
