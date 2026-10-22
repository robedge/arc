import { basename, isAbsolute, normalize, resolve, sep } from 'node:path'

/** A folder an agent reads files in, and the name its files carry in a normalized path. */
export interface ReadRoot {
  path: string
  name: string
}

export interface ReadContext {
  /** The folder relative paths are resolved against; null when the agent has none. */
  cwd: string | null
  roots: readonly ReadRoot[]
}

/** `<worktrees root>/<session>/<worker>/<repo>/<path>` */
const WORKTREE_PATH = /[\\/]worktrees[\\/][^\\/]+[\\/][^\\/]+[\\/]([^\\/]+)[\\/](.+)$/

/**
 * A file an agent read, as `<repo>/<path>` so that two workers' copies of one file (and the user's
 * checkout) count as one. Relative paths resolve against the agent's folder; a path inside a known
 * root, or shaped like a worker worktree, loses everything before the repository folder. Any other
 * path stays as it is.
 */
export function normalizeReadPath(raw: string, context: ReadContext): string {
  const trimmed = raw.trim()
  let path: string
  if (isAbsolute(trimmed)) path = normalize(trimmed)
  else if (context.cwd !== null) path = resolve(context.cwd, trimmed)
  else return normalize(trimmed)
  const roots = [...context.roots].sort((a, b) => b.path.length - a.path.length)
  for (const root of roots) {
    const base = normalize(root.path).replace(/[\\/]+$/, '')
    if (path.startsWith(base + sep)) return `${root.name}/${path.slice(base.length + 1)}`
  }
  const match = WORKTREE_PATH.exec(path)
  if (match) return `${match[1]}/${match[2]}`
  return path
}

/** A root named after its folder, which is how worker working copies are named. */
export function rootOf(path: string): ReadRoot {
  return { path, name: basename(path) }
}
