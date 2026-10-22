import { realpath } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { AppErrorException } from '@shared/errors'

// eslint-disable-next-line no-control-regex -- control characters are exactly what is being stripped
const FORBIDDEN_CHARS = /[/:\\\u0000-\u001f\u007f-\u009f]/g

/**
 * Turns user text into a safe single path segment: NFC, strips `/ : \ NUL` and control
 * characters, collapses whitespace, strips leading dots and trailing dots/spaces.
 * Returns '' when nothing usable is left.
 */
export function sanitizeName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(FORBIDDEN_CHARS, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '')
}

export interface ResolveOptions {
  /** Permit the exact segment `.arc` (the metadata directory). */
  allowMetaDir?: boolean
}

function isSafeSegment(segment: string, options: ResolveOptions): boolean {
  if (segment.length === 0 || segment === '.' || segment === '..') return false
  // eslint-disable-next-line no-control-regex -- NUL is rejected on purpose
  if (/[/\\\u0000]/.test(segment)) return false
  if (segment.startsWith('.')) return options.allowMetaDir === true && segment === '.arc'
  return true
}

async function nearestExistingRealpath(path: string): Promise<string> {
  let current = path
  for (;;) {
    try {
      return await realpath(current)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

/**
 * Joins `segments` under `root` and proves the result stays inside it: every segment is a
 * plain name, and the real path of the target's parent (or its nearest existing ancestor)
 * lies inside the real path of `root`, so symlinks cannot escape. The leaf may not exist yet.
 */
export async function resolveInRoot(
  root: string,
  segments: readonly string[],
  options: ResolveOptions = {}
): Promise<string> {
  if (segments.length === 0 || !segments.every((s) => isSafeSegment(s, options))) {
    throw new AppErrorException('PATH_OUTSIDE_ROOT')
  }
  let realRoot: string
  try {
    realRoot = await realpath(root)
  } catch {
    throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
  }
  const target = join(root, ...segments)
  let realParent: string
  try {
    realParent = await nearestExistingRealpath(dirname(target))
  } catch {
    throw new AppErrorException('PATH_OUTSIDE_ROOT')
  }
  if (realParent !== realRoot && !realParent.startsWith(realRoot + sep)) {
    throw new AppErrorException('PATH_OUTSIDE_ROOT')
  }
  return target
}

function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Returns `desired`, or `name (2).ext`, `name (3).ext`, ... when it collides with an
 * existing name (compared NFC-normalized and case-insensitively).
 */
export function uniqueName(existingNames: Iterable<string>, desired: string): string {
  const taken = new Set<string>()
  for (const n of existingNames) taken.add(nameKey(n))
  if (!taken.has(nameKey(desired))) return desired

  const dot = desired.lastIndexOf('.')
  const hasExt = dot > 0
  const base = hasExt ? desired.slice(0, dot) : desired
  const ext = hasExt ? desired.slice(dot) : ''
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`
    if (!taken.has(nameKey(candidate))) return candidate
  }
}
