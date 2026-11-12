import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/**
 * Where a working copy's git data lives: its admin directory (`<common>/worktrees/<id>` for a
 * linked worktree, read from its `.git` file, never guessed from the folder name) and the common
 * directory it shares. A folder with no `.git` file (a plain repository has a `.git` directory, which
 * is its own common directory) gives `null`.
 */
export function gitDirsOf(worktree: string): { gitdir: string; common: string } | null {
  const dotGit = join(worktree, '.git')
  let text: string
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return { gitdir: dotGit, common: dotGit }
    text = readFileSync(dotGit, 'utf8')
  } catch {
    return null
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text)
  const gitdirText = match?.[1]
  if (!gitdirText) return null
  const gitdir = isAbsolute(gitdirText) ? gitdirText : resolve(worktree, gitdirText)
  let common = dirname(dirname(gitdir))
  const commondirFile = join(gitdir, 'commondir')
  if (existsSync(commondirFile)) {
    const relative = readFileSync(commondirFile, 'utf8').trim()
    if (relative) common = resolve(gitdir, relative)
  }
  return { gitdir, common }
}

/**
 * Git reads `info/exclude` from the repository's common directory only: the file under
 * `worktrees/<id>/info/` that one might expect is ignored. So the line goes into the common file,
 * which also covers every other working copy of that repository. It never touches a tracked file.
 */
export function excludeFromGit(worktree: string, entry: string): void {
  const dirs = gitDirsOf(worktree)
  if (!dirs) return
  const file = join(dirs.common, 'info', 'exclude')
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const bare = entry.replace(/\/$/, '')
  const covered = existing
    .split('\n')
    .some((line) => [bare, `${bare}/`, `/${bare}`, `/${bare}/`].includes(line.trim()))
  if (covered) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${entry}\n`)
}
