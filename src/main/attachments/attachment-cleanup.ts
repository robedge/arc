import { lstatSync, readdirSync, rmSync } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Error code (`ENOENT`, `EACCES`) only: an fs error's message holds the path. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : 'UNKNOWN'
}

/**
 * Staged files do not survive a restart (tech spec 2.3). Empties `userData/attachment-staging`,
 * keeps the folder, and runs before any renderer can stage. Best effort, never throws. A symlink
 * (the root itself or an entry in it) is unlinked, never followed.
 */
export function clearStagingRoot(root: string, log?: { warn: (message: string) => void }): void {
  try {
    if (!lstatSync(root).isDirectory()) return
    for (const entry of readdirSync(root)) {
      try {
        rmSync(join(root, entry), { recursive: true, force: true })
      } catch (error: unknown) {
        log?.warn(`could not clear a staged attachment folder (${codeOf(error)})`)
      }
    }
  } catch (error: unknown) {
    if (codeOf(error) !== 'ENOENT')
      log?.warn(`could not clear the staging folder (${codeOf(error)})`)
  }
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/
const SESSION_ID = /^[\w-]+$/
/** A folder touched more recently than this may belong to a send that is copying files right now. */
export const SWEEP_GRACE_MS = 60_000
/** Ids per row lookup, under SQLite's variable limit. */
const LOOKUP_BATCH = 200

export interface OrphanSweepDeps {
  /** `userData/sessions`. */
  sessionsRoot: string
  /** A session folder whose session row is gone is left to the code that owns session folders. */
  sessionExists: (sessionId: string) => boolean
  /** The subset of `ids` that have a `message_attachments` row in this session. */
  knownIds: (sessionId: string, ids: string[]) => readonly string[]
  now: () => number
  graceMs?: number
  log: { warn: (message: string) => void }
}

/**
 * A crash between copying files and inserting rows leaves `sessions/<id>/attachments/<id>/`
 * folders with no row. Removes them. One row lookup per session that has candidates, so the work
 * follows the folders present, not the table size. Folders newer than the grace period are skipped
 * so a send in progress is never raced. Best effort, never throws.
 */
export async function sweepOrphanAttachmentFolders(
  deps: OrphanSweepDeps
): Promise<{ removed: number }> {
  let removed = 0
  const grace = deps.graceMs ?? SWEEP_GRACE_MS
  let sessions: string[]
  try {
    sessions = await readdir(deps.sessionsRoot)
  } catch {
    return { removed }
  }
  for (const sessionId of sessions) {
    if (!SESSION_ID.test(sessionId)) continue
    try {
      if (!deps.sessionExists(sessionId)) continue
      const root = join(deps.sessionsRoot, sessionId, 'attachments')
      let names: string[]
      try {
        names = (await readdir(root)).filter((n) => ULID.test(n))
      } catch {
        continue
      }
      const candidates: string[] = []
      for (const name of names) {
        const info = await lstat(join(root, name)).catch(() => undefined)
        if (!info || !info.isDirectory()) continue
        if (deps.now() - info.mtimeMs < grace) continue
        candidates.push(name)
      }
      if (candidates.length === 0) continue
      const known = new Set<string>()
      for (let i = 0; i < candidates.length; i += LOOKUP_BATCH) {
        for (const id of deps.knownIds(sessionId, candidates.slice(i, i + LOOKUP_BATCH))) {
          known.add(id)
        }
      }
      for (const name of candidates) {
        if (known.has(name)) continue
        await rm(join(root, name), { recursive: true, force: true })
        removed += 1
      }
    } catch (error: unknown) {
      deps.log.warn(`attachment sweep skipped a session (${codeOf(error)})`)
    }
  }
  return { removed }
}
