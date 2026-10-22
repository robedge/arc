import { lstat, open, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { DiffHunk, DiffLine, ReviewUncommittedFile } from '../../shared/types/review'

/** An untracked file above this size is `large` with no content read. */
export const UNTRACKED_MAX_BYTES = 1024 * 1024
const BINARY_SNIFF_BYTES = 8192

export interface UntrackedFile {
  file: ReviewUncommittedFile
  /** The text lines when the file is readable text (not binary, not over the cap). */
  lines: string[] | null
  /** The last line has no trailing newline. */
  noNewlineAtEnd: boolean
}

/**
 * Resolves `path` inside `repo` to a regular file. A symlink is followed only when it ends up inside the
 * repository; anything else (outside, missing, a directory, a device) gives null. Returns the real path.
 */
export async function resolveInsideRepo(repo: string, path: string): Promise<string | null> {
  try {
    const root = await realpath(repo)
    const full = join(root, path)
    const inside = (p: string): boolean => {
      const rel = relative(root, p)
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
    }
    if (!inside(full)) return null
    await lstat(full)
    const real = await realpath(full)
    if (!inside(real)) return null
    return (await stat(real)).isFile() ? real : null
  } catch {
    return null
  }
}

/** Reads one untracked file for the "Not committed" list; null when it cannot be shown at all. */
export async function readUntracked(repo: string, path: string): Promise<UntrackedFile | null> {
  const real = await resolveInsideRepo(repo, path)
  if (real === null) return null
  const base = { path, status: 'A' as const, added: 0, removed: 0 }
  const size = (await stat(real)).size
  if (size > UNTRACKED_MAX_BYTES) {
    return { file: { ...base, binary: false, large: true }, lines: null, noNewlineAtEnd: false }
  }
  const handle = await open(real, 'r')
  let head: Buffer
  try {
    head = Buffer.alloc(Math.min(size, BINARY_SNIFF_BYTES))
    await handle.read(head, 0, head.length, 0)
  } finally {
    await handle.close()
  }
  if (head.includes(0))
    return { file: { ...base, binary: true, large: false }, lines: null, noNewlineAtEnd: false }
  const text = (await readFile(real)).toString('utf8')
  const lines = text === '' ? [] : text.split('\n')
  const endsWithNewline = text.endsWith('\n')
  if (endsWithNewline) lines.pop()
  return {
    file: { ...base, added: lines.length, binary: false, large: false },
    lines,
    noNewlineAtEnd: lines.length > 0 && !endsWithNewline
  }
}

/** The single all-added hunk of a new file (nothing for an empty one). */
export function hunkOfNewFile(lines: string[], noNewlineAtEnd: boolean): DiffHunk[] {
  if (lines.length === 0) return []
  const body: DiffLine[] = lines.map((text, i) => ({ kind: 'add', newNo: i + 1, text }))
  if (noNewlineAtEnd) (body[body.length - 1] as DiffLine).noNewline = true
  return [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: lines.length,
      header: `@@ -0,0 +1,${lines.length} @@`,
      lines: body
    }
  ]
}
