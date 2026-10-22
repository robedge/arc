import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { ReviewMarksRepo } from '../../../src/main/db/repositories/review-marks-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { projects, reviewFileMarks } from '../../../src/main/db/schema'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let repo: ReviewMarksRepo
let spA: number
let spB: number
let spOther: number

function addSession(id: string): void {
  sessions.create({
    id,
    groupId: 'g1',
    name: id,
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
}

function snap(sessionId: string, projectId: string) {
  return {
    sessionId,
    projectId,
    readOnly: false,
    projectPath: `/repo/${projectId}`,
    projectName: projectId
  }
}

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  new GroupsRepo(opened.db).insert({
    id: 'g1',
    name: 'g',
    nameKey: 'g',
    createdAt: 1,
    updatedAt: 1
  })
  sessions = new SessionsRepo(opened.db)
  addSession('s1')
  addSession('s2')
  for (const id of ['p1', 'p2']) {
    opened.db
      .insert(projects)
      .values({ id, path: `/repo/${id}`, displayName: id, createdAt: 1 })
      .run()
  }
  const sp = new SessionProjectsRepo(opened.db)
  const [a, b] = sp.insertMany([snap('s1', 'p1'), snap('s1', 'p2')])
  const [o] = sp.insertMany([snap('s2', 'p1')])
  spA = a!.id
  spB = b!.id
  spOther = o!.id
  repo = new ReviewMarksRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

describe('ReviewMarksRepo', () => {
  it('enforces foreign keys in this SQLite setup', () => {
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(() => repo.mark(99999, 'a.ts', 'f1', 1)).toThrow()
  })

  it('marks and lists by project', () => {
    repo.mark(spA, 'src/a.ts', 'f1', 100)
    expect(repo.listByProject(spA)).toMatchObject([
      { sessionProjectId: spA, path: 'src/a.ts', fingerprint: 'f1', markedAt: 100 }
    ])
    expect(repo.listByProject(spB)).toEqual([])
  })

  it('mark upserts, overwriting fingerprint and marked_at', () => {
    repo.mark(spA, 'src/a.ts', 'f1', 100)
    repo.mark(spA, 'src/a.ts', 'f2', 200)
    const rows = repo.listByProject(spA)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ fingerprint: 'f2', markedAt: 200 })
  })

  it('defaults marked_at to now', () => {
    const before = Date.now()
    repo.mark(spA, 'a.ts', 'f1')
    expect(repo.listByProject(spA)[0]!.markedAt).toBeGreaterThanOrEqual(before)
  })

  it('unmark and deleteByPath remove only that row', () => {
    repo.mark(spA, 'a.ts', 'f1', 1)
    repo.mark(spA, 'b.ts', 'f1', 1)
    repo.mark(spA, 'c.ts', 'f1', 1)
    repo.unmark(spA, 'a.ts')
    repo.deleteByPath(spA, 'b.ts')
    repo.unmark(spA, 'missing.ts')
    expect(repo.listByProject(spA).map((r) => r.path)).toEqual(['c.ts'])
  })

  it('stores paths case-sensitively', () => {
    repo.mark(spA, 'A.ts', 'f1', 1)
    repo.mark(spA, 'a.ts', 'f2', 1)
    expect(repo.listByProject(spA).map((r) => r.path)).toEqual(['A.ts', 'a.ts'])
  })

  it('enforces uniqueness on (session project, path) at the table level', () => {
    const row = { sessionProjectId: spA, path: 'a.ts', fingerprint: 'f', markedAt: 1 }
    opened.db.insert(reviewFileMarks).values(row).run()
    expect(() => opened.db.insert(reviewFileMarks).values(row).run()).toThrow(/UNIQUE/)
  })

  it('listBySession joins through session_projects', () => {
    repo.mark(spA, 'a.ts', 'f1', 1)
    repo.mark(spB, 'b.ts', 'f2', 2)
    repo.mark(spOther, 'x.ts', 'f3', 3)
    expect(repo.listBySession('s1')).toEqual([
      { sessionProjectId: spA, projectId: 'p1', path: 'a.ts', fingerprint: 'f1', markedAt: 1 },
      { sessionProjectId: spB, projectId: 'p2', path: 'b.ts', fingerprint: 'f2', markedAt: 2 }
    ])
    expect(repo.listBySession('s2').map((r) => r.path)).toEqual(['x.ts'])
    expect(repo.listBySession('nope')).toEqual([])
  })

  it('cascades when the session is deleted', () => {
    repo.mark(spA, 'a.ts', 'f1', 1)
    repo.mark(spB, 'b.ts', 'f1', 1)
    repo.mark(spOther, 'x.ts', 'f1', 1)
    sessions.delete('s1')
    expect(
      opened.db
        .select()
        .from(reviewFileMarks)
        .all()
        .map((r) => r.path)
    ).toEqual(['x.ts'])
  })
})
