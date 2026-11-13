import { existsSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  clearStagingRoot,
  sweepOrphanAttachmentFolders
} from '../../../src/main/attachments/attachment-cleanup'
import { ulid } from '../../../src/main/db/ids'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-att-clean-')

describe('clearStagingRoot', () => {
  it('empties the staging root and keeps the root itself', () => {
    const root = join(dir(), 'attachment-staging')
    mkdirSync(join(root, ulid(), ulid()), { recursive: true })
    writeFileSync(join(root, 'stray.txt'), 'x')
    clearStagingRoot(root)
    expect(existsSync(root)).toBe(true)
    expect(existsSync(join(root, 'stray.txt'))).toBe(false)
    expect(existsSync(join(root))).toBe(true)
  })

  it('does nothing when the root does not exist, and never throws', () => {
    expect(() => clearStagingRoot(join(dir(), 'absent'))).not.toThrow()
    expect(existsSync(join(dir(), 'absent'))).toBe(false)
  })

  it('removes a symlink inside staging without touching what it points at', () => {
    const outside = join(dir(), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const root = join(dir(), 'attachment-staging')
    mkdirSync(join(root, 'draft'), { recursive: true })
    symlinkSync(outside, join(root, 'draft', 'link'))
    symlinkSync(outside, join(root, 'toplink'))
    clearStagingRoot(root)
    expect(existsSync(join(root, 'draft'))).toBe(false)
    expect(existsSync(join(root, 'toplink'))).toBe(false)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('does not follow a staging root that is itself a symlink', () => {
    const outside = join(dir(), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    const root = join(dir(), 'attachment-staging')
    symlinkSync(outside, root)
    clearStagingRoot(root)
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })
})

const OLD = Date.now() - 10 * 60_000

/** An attachment folder with one file, aged so the grace period does not protect it. */
function attachmentFolder(sessionsRoot: string, sessionId: string, id: string, at = OLD): string {
  const folder = join(sessionsRoot, sessionId, 'attachments', id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'file.txt'), 'x')
  utimesSync(folder, at / 1000, at / 1000)
  return folder
}

function sweepWith(
  sessionsRoot: string,
  rows: Record<string, string[]>,
  extra: { sessions?: string[]; log?: { warn: (m: string) => void } } = {}
): ReturnType<typeof sweepOrphanAttachmentFolders> {
  return sweepOrphanAttachmentFolders({
    sessionsRoot,
    sessionExists: (id) => (extra.sessions ?? Object.keys(rows)).includes(id),
    knownIds: (sessionId, ids) => ids.filter((id) => (rows[sessionId] ?? []).includes(id)),
    now: () => Date.now(),
    log: extra.log ?? { warn: vi.fn() }
  })
}

describe('sweepOrphanAttachmentFolders', () => {
  it('removes an attachment folder with no row and keeps one with a row', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const kept = ulid()
    const orphan = ulid()
    const keptDir = attachmentFolder(root, sid, kept)
    const orphanDir = attachmentFolder(root, sid, orphan)
    const result = await sweepWith(root, { [sid]: [kept] })
    expect(existsSync(orphanDir)).toBe(false)
    expect(existsSync(keptDir)).toBe(true)
    expect(result.removed).toBe(1)
  })

  it('considers only ULID-shaped names', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const other = join(root, sid, 'attachments', 'notes')
    mkdirSync(other, { recursive: true })
    utimesSync(other, OLD / 1000, OLD / 1000)
    writeFileSync(join(root, sid, 'attachments', 'loose.txt'), 'x')
    await sweepWith(root, { [sid]: [] })
    expect(existsSync(other)).toBe(true)
    expect(existsSync(join(root, sid, 'attachments', 'loose.txt'))).toBe(true)
  })

  it('leaves a session folder with no session row alone', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const folder = attachmentFolder(root, sid, ulid())
    await sweepWith(root, {}, { sessions: [] })
    expect(existsSync(folder)).toBe(true)
  })

  it('skips a folder newer than the grace period (a send may be copying into it)', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const fresh = attachmentFolder(root, sid, ulid(), Date.now() - 1000)
    const result = await sweepWith(root, { [sid]: [] })
    expect(existsSync(fresh)).toBe(true)
    expect(result.removed).toBe(0)
  })

  it('does not follow a symlinked entry out of the attachments folder', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const outside = join(dir(), 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    await mkdir(join(root, sid, 'attachments'), { recursive: true })
    symlinkSync(outside, join(root, sid, 'attachments', ulid()))
    await sweepWith(root, { [sid]: [] })
    expect(existsSync(join(outside, 'keep.txt'))).toBe(true)
  })

  it('looks rows up with one call per session, in bounded batches', async () => {
    const root = join(dir(), 'sessions')
    const a = ulid()
    const b = ulid()
    for (let i = 0; i < 3; i++) attachmentFolder(root, a, ulid())
    attachmentFolder(root, b, ulid())
    mkdirSync(join(root, ulid()), { recursive: true }) // a session folder with nothing in it
    const knownIds = vi.fn<(sessionId: string, ids: string[]) => string[]>(() => [])
    await sweepOrphanAttachmentFolders({
      sessionsRoot: root,
      sessionExists: () => true,
      knownIds,
      now: () => Date.now(),
      log: { warn: vi.fn() }
    })
    expect(knownIds).toHaveBeenCalledTimes(2)
    expect(knownIds.mock.calls.map((c) => c[1].length).sort()).toEqual([1, 3])
  })

  it('never throws: a lookup failure is logged by code only and the session is skipped', async () => {
    const root = join(dir(), 'sessions')
    const sid = ulid()
    const folder = attachmentFolder(root, sid, ulid())
    const warn = vi.fn()
    const result = await sweepOrphanAttachmentFolders({
      sessionsRoot: root,
      sessionExists: () => true,
      knownIds: () => {
        throw new Error(`boom at ${folder}`)
      },
      now: () => Date.now(),
      log: { warn }
    })
    expect(result.removed).toBe(0)
    expect(existsSync(folder)).toBe(true)
    expect(JSON.stringify(warn.mock.calls)).not.toContain(folder)
  })

  it('does nothing when there is no sessions folder', async () => {
    const result = await sweepWith(join(dir(), 'absent'), {})
    expect(result.removed).toBe(0)
  })
})
