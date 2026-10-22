import type { DiffHunk, DiffLine, ReviewFile, ReviewFileStatus } from '../../shared/types/review'
import { createHash } from 'node:crypto'
import { GitError, LONG_GIT_TIMEOUT_MS } from './git'
import type { GitRunner } from './git'

/**
 * Read-only git calls behind change review (tech spec 2.2). Every diff passes `--no-ext-diff --no-textconv`
 * so a repository's own config can never run a diff tool or text conversion.
 */

/** A file with more changed lines than this is `large`: it is only shown on request. */
export const LARGE_FILE_LINES = 2000
/** A file with more changed lines than this is never shown (`tooLarge`), which keeps output well under the git buffer. */
export const TOO_LARGE_FILE_LINES = 50_000
/** Above this many changed files rename detection is skipped, which keeps big diffs fast. */
export const RENAME_DETECTION_MAX_FILES = 2000
const RENAME_LIMIT = 1000

/**
 * A changed file as git reports it; who changed it and whether it is reviewed are added by the review service.
 * `fingerprint` is internal: a hash of the base blob, tip blob and status (and the old path of a rename), so a
 * review mark can tell whether the file changed again. It never reaches the renderer.
 */
export type ReviewFileChange = Omit<ReviewFile, 'workers' | 'reviewed' | 'changedSinceReviewed'> & {
  fingerprint: string
}

export interface ReviewGit {
  /** The files that differ between `base` and `tip`, sorted by path. */
  listChanges(repo: string, base: string, tip: string): Promise<ReviewFileChange[]>
  /** `merge-base <a> <b>`, or null when the two have no common ancestor (or a ref is gone). */
  mergeBase(repo: string, a: string, b: string): Promise<string | null>
  /** One file's unified diff (3 lines of context) as git prints it; `oldPath` is the pre-rename path. */
  fileDiff(repo: string, base: string, tip: string, path: string, oldPath?: string): Promise<string>
  /** The branch HEAD is on, or null when HEAD is detached. */
  currentBranch(repo: string): Promise<string | null>
  /**
   * The working tree against HEAD (staged and unstaged together) and the untracked paths. Untracked files
   * inside untracked directories are listed one by one.
   */
  uncommittedChanges(repo: string): Promise<{ tracked: ReviewFileChange[]; untracked: string[] }>
  /** `rev-list --count <from>..<to>`; 0 when either commit is unknown. */
  countCommits(repo: string, from: string, to: string): Promise<number>
  /** One tracked file's unified diff of the working tree against HEAD; `oldPath` is the pre-rename path. */
  headFileDiff(repo: string, path: string, oldPath?: string): Promise<string>
}

/** The untracked paths (`??`) of `status --porcelain=v1 -z`. */
export function parseUntracked(output: string): string[] {
  const entries = output.split('\0').filter((e) => e.length > 0)
  const paths: string[] = []
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] as string
    if (entry.startsWith('?? ')) paths.push(entry.slice(3))
    else if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') i++
  }
  return paths.sort()
}

interface RawEntry {
  status: ReviewFileStatus
  path: string
  oldPath?: string
  fingerprint: string
}

interface Counts {
  added: number
  removed: number
  binary: boolean
}

function fingerprintOf(
  baseBlob: string,
  tipBlob: string,
  status: ReviewFileStatus,
  oldPath?: string
): string {
  const parts = [baseBlob, tipBlob, status]
  if (oldPath !== undefined) parts.push(oldPath)
  return createHash('sha1').update(parts.join(':')).digest('hex')
}

function statusOf(letter: string): ReviewFileStatus | null {
  switch (letter) {
    case 'A':
      return 'A'
    case 'D':
      return 'D'
    case 'R':
      return 'R'
    case 'M':
    case 'T':
      return 'M'
    default:
      return null
  }
}

/**
 * Parses the output of `diff --raw --numstat -z`: first the NUL-separated raw records
 * (`:<modes> <shas> <status>\0<path>[\0<newPath>]`), then the numstat records
 * (`<added>\t<removed>\t<path>` or, for a rename, `<added>\t<removed>\t\0<old>\0<new>`).
 */
export function parseRawNumstat(output: string): ReviewFileChange[] {
  const parts = output.split('\0')
  const entries: RawEntry[] = []
  const counts = new Map<string, Counts>()
  let i = 0
  while (i < parts.length) {
    const part = parts[i] as string
    if (part.startsWith(':')) {
      // `:<old mode> <new mode> <old blob> <new blob> <status>`
      const fields = part.split(' ')
      const letter = fields[4] ?? ''
      const baseBlob = fields[2] ?? ''
      const tipBlob = fields[3] ?? ''
      const status = statusOf(letter.charAt(0))
      if (status === 'R' || letter.charAt(0) === 'C') {
        const oldPath = parts[i + 1] ?? ''
        const path = parts[i + 2] ?? ''
        if (status === 'R') {
          entries.push({
            status,
            path,
            oldPath,
            fingerprint: fingerprintOf(baseBlob, tipBlob, status, oldPath)
          })
        }
        i += 3
      } else {
        const path = parts[i + 1] ?? ''
        if (status !== null) {
          entries.push({ status, path, fingerprint: fingerprintOf(baseBlob, tipBlob, status) })
        }
        i += 2
      }
      continue
    }
    const numstat = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(part)
    if (numstat) {
      const [, addedText = '', removedText = '', inlinePath = ''] = numstat
      const binary = addedText === '-'
      const record: Counts = {
        added: binary ? 0 : Number(addedText),
        removed: binary ? 0 : Number(removedText),
        binary
      }
      if (inlinePath === '') {
        // A rename or copy: the next two parts are the old and the new path.
        counts.set(parts[i + 2] ?? '', record)
        i += 3
      } else {
        counts.set(inlinePath, record)
        i += 1
      }
      continue
    }
    i += 1
  }
  return entries
    .map((entry): ReviewFileChange => {
      const c = counts.get(entry.path) ?? { added: 0, removed: 0, binary: false }
      const file: ReviewFileChange = {
        path: entry.path,
        status: entry.status,
        fingerprint: entry.fingerprint,
        added: c.added,
        removed: c.removed,
        binary: c.binary,
        large: c.added + c.removed > LARGE_FILE_LINES
      }
      if (entry.oldPath !== undefined) file.oldPath = entry.oldPath
      return file
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parses one file's unified diff into hunks with old and new line numbers. Everything before the first
 * `@@` (the `diff --git`, mode, rename and `---`/`+++` lines) is skipped, so a pure rename or a mode-only
 * change gives no hunks. Lines are split on `\n` only: a CR stays in the text of a CRLF file.
 */
export function parseUnifiedDiff(output: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let hunk: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  for (const raw of output.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header) {
      const [, oldStart = '0', oldLines = '1', newStart = '0', newLines = '1'] = header
      hunk = {
        oldStart: Number(oldStart),
        oldLines: Number(oldLines),
        newStart: Number(newStart),
        newLines: Number(newLines),
        header: raw,
        lines: []
      }
      oldNo = hunk.oldStart
      newNo = hunk.newStart
      hunks.push(hunk)
      continue
    }
    if (hunk === null || raw === '') continue
    const marker = raw.charAt(0)
    const text = raw.slice(1)
    let line: DiffLine
    if (marker === '+') {
      line = { kind: 'add', newNo, text }
      newNo += 1
    } else if (marker === '-') {
      line = { kind: 'del', oldNo, text }
      oldNo += 1
    } else if (marker === ' ') {
      line = { kind: 'ctx', oldNo, newNo, text }
      oldNo += 1
      newNo += 1
    } else {
      // "\ No newline at end of file" belongs to the line before it.
      const last = hunk.lines[hunk.lines.length - 1]
      if (marker === '\\' && last) last.noNewline = true
      continue
    }
    hunk.lines.push(line)
  }
  return hunks
}

export function createReviewGit(git: GitRunner): ReviewGit {
  const NO_TOOLS = ['--no-ext-diff', '--no-textconv']

  async function countFiles(repo: string, base: string, tip: string): Promise<number> {
    const out = await git(repo, [
      'diff',
      '--name-only',
      '--no-renames',
      '-z',
      ...NO_TOOLS,
      base,
      tip
    ])
    return out.split('\0').filter((p) => p !== '').length
  }

  return {
    async listChanges(repo, base, tip) {
      const detectRenames = (await countFiles(repo, base, tip)) <= RENAME_DETECTION_MAX_FILES
      const out = await git(repo, [
        'diff',
        '--raw',
        '--numstat',
        '-z',
        detectRenames ? '-M' : '--no-renames',
        `-l${RENAME_LIMIT}`,
        ...NO_TOOLS,
        base,
        tip
      ])
      return parseRawNumstat(out)
    },
    async fileDiff(repo, base, tip, path, oldPath) {
      return git(
        repo,
        [
          'diff',
          '-M',
          '-U3',
          '--no-color',
          ...NO_TOOLS,
          base,
          tip,
          '--',
          ...(oldPath !== undefined && oldPath !== path ? [oldPath, path] : [path])
        ],
        { timeoutMs: LONG_GIT_TIMEOUT_MS }
      )
    },
    async countCommits(repo, from, to) {
      try {
        const out = await git(repo, ['rev-list', '--count', `${from}..${to}`])
        const n = Number.parseInt(out.trim(), 10)
        return Number.isFinite(n) ? n : 0
      } catch (error: unknown) {
        if (error instanceof GitError && error.kind === 'failed') return 0
        throw error
      }
    },
    async currentBranch(repo) {
      try {
        const out = (await git(repo, ['symbolic-ref', '-q', '--short', 'HEAD'])).trim()
        return out === '' ? null : out
      } catch (error: unknown) {
        if (error instanceof GitError && error.kind === 'failed') return null
        throw error
      }
    },
    async uncommittedChanges(repo) {
      const [diff, status] = await Promise.all([
        git(repo, [
          'diff',
          '--raw',
          '--numstat',
          '-z',
          '-M',
          `-l${RENAME_LIMIT}`,
          ...NO_TOOLS,
          'HEAD'
        ]),
        git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
      ])
      return { tracked: parseRawNumstat(diff), untracked: parseUntracked(status) }
    },
    async headFileDiff(repo, path, oldPath) {
      return git(
        repo,
        [
          'diff',
          '-M',
          '-U3',
          '--no-color',
          ...NO_TOOLS,
          'HEAD',
          '--',
          ...(oldPath !== undefined && oldPath !== path ? [oldPath, path] : [path])
        ],
        { timeoutMs: LONG_GIT_TIMEOUT_MS }
      )
    },
    async mergeBase(repo, a, b) {
      try {
        const out = (await git(repo, ['merge-base', a, b])).trim()
        return out === '' ? null : out
      } catch (error: unknown) {
        if (error instanceof GitError && error.kind === 'failed') return null
        throw error
      }
    }
  }
}
