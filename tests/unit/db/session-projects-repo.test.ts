import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { projects } from '../../../src/main/db/schema'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let repo: SessionProjectsRepo

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
  sessions.create({
    id: 's1',
    groupId: 'g1',
    name: 's1',
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
  for (const id of ['p1', 'p2']) {
    opened.db
      .insert(projects)
      .values({ id, path: `/repo/${id}`, displayName: id, createdAt: 1 })
      .run()
  }
  repo = new SessionProjectsRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

function snap(projectId: string, readOnly = false) {
  return {
    sessionId: 's1',
    projectId,
    readOnly,
    projectPath: `/repo/${projectId}`,
    projectName: projectId
  }
}

describe('SessionProjectsRepo', () => {
  it('inserts and lists with defaults', () => {
    repo.insertMany([snap('p1'), snap('p2', true)])
    const rows = repo.listBySession('s1')
    expect(rows.map((r) => r.projectId)).toEqual(['p1', 'p2'])
    expect(rows[0]).toMatchObject({
      branchName: null,
      baseBranch: null,
      previousBranch: null,
      readOnly: false,
      dirtyHandling: 'none',
      stashRef: null
    })
    expect(rows[1]?.readOnly).toBe(true)
  })

  it('rejects a duplicate (session, project) pair', () => {
    repo.insertMany([snap('p1')])
    expect(() => repo.insertMany([snap('p1')])).toThrow()
  })

  it('cascades on session delete', () => {
    repo.insertMany([snap('p1')])
    sessions.delete('s1')
    expect(repo.listBySession('s1')).toEqual([])
  })

  it('keeps the snapshot row with a null project_id when the project is deleted', () => {
    repo.insertMany([snap('p1')])
    opened.db.delete(projects).where(eq(projects.id, 'p1')).run()
    const rows = repo.listBySession('s1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ projectId: null, projectPath: '/repo/p1', projectName: 'p1' })
  })

  it('setBranch records branch, base and previous branch', () => {
    repo.insertMany([snap('p1'), snap('p2')])
    repo.setBranch('s1', 'p1', 'arc/x', 'main', 'dev')
    const [a, b] = repo.listBySession('s1')
    expect(a).toMatchObject({ branchName: 'arc/x', baseBranch: 'main', previousBranch: 'dev' })
    expect(b?.branchName).toBeNull()
  })

  it('setDirtyHandling sets handling and stash ref, clearing the ref by default', () => {
    repo.insertMany([snap('p1')])
    repo.setDirtyHandling('s1', 'p1', 'stashed', 'stash@{0}')
    expect(repo.listBySession('s1')[0]).toMatchObject({
      dirtyHandling: 'stashed',
      stashRef: 'stash@{0}'
    })
    repo.setDirtyHandling('s1', 'p1', 'carried')
    expect(repo.listBySession('s1')[0]).toMatchObject({ dirtyHandling: 'carried', stashRef: null })
  })
  describe('base_sha', () => {
    it('reads null by default and writes once when null', () => {
      const [row] = repo.insertMany([snap('p1')])
      expect(row?.baseSha).toBeNull()
      expect(repo.setBaseSha(row!.id, 'abc123')).toBe(true)
      expect(repo.listBySession('s1')[0]?.baseSha).toBe('abc123')
    })

    it('does not overwrite an existing value', () => {
      const [row] = repo.insertMany([snap('p1')])
      repo.setBaseSha(row!.id, 'first')
      expect(repo.setBaseSha(row!.id, 'second')).toBe(false)
      expect(repo.listBySession('s1')[0]?.baseSha).toBe('first')
    })

    it('reads null for rows created before migration 0015', () => {
      const old = join(dir(), 'old-migrations')
      cpSync(realMigrations, old, { recursive: true })
      const journalPath = join(old, 'meta', '_journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[]
      }
      // drizzle applies by last-applied timestamp, so drop 0015 and every later migration
      journal.entries = journal.entries.filter((e) => e.tag < '0015')
      writeFileSync(journalPath, JSON.stringify(journal))
      const dbPath = join(dir(), 'legacy.db')
      const legacy = openDatabase({ dbPath, migrationsFolder: old })
      legacy.sqlite.exec(
        `INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES ('g1','g','g',1,1);
         INSERT INTO sessions (id, group_id, name, mode, worker_limit, status, created_at, last_active_at) VALUES ('s1','g1','s1','plan_first',3,'active',1,1);
         INSERT INTO session_projects (session_id, project_path, project_name) VALUES ('s1','/r','r');`
      )
      legacy.sqlite.close()
      const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
      const rows = new SessionProjectsRepo(upgraded.db).listBySession('s1')
      upgraded.sqlite.close()
      expect(rows).toHaveLength(1)
      expect(rows[0]?.baseSha).toBeNull()
    })
  })

  describe('recordPush', () => {
    const push = { remote: 'origin', branch: 'arc/x', sha: 'aaa111', at: 100 }

    it('writes all four fields', () => {
      const [row] = repo.insertMany([snap('p1')])
      expect(row).toMatchObject({
        pushedRemote: null,
        pushedBranch: null,
        pushedSha: null,
        pushedAt: null
      })
      expect(repo.recordPush(row!.id, push)).toBe(true)
      expect(repo.listBySession('s1')[0]).toMatchObject({
        pushedRemote: 'origin',
        pushedBranch: 'arc/x',
        pushedSha: 'aaa111',
        pushedAt: 100
      })
    })

    it('overwrites the previous push', () => {
      const [row] = repo.insertMany([snap('p1')])
      repo.recordPush(row!.id, push)
      repo.recordPush(row!.id, { remote: 'up', branch: 'arc/y', sha: 'bbb222', at: 200 })
      expect(repo.listBySession('s1')[0]).toMatchObject({
        pushedRemote: 'up',
        pushedBranch: 'arc/y',
        pushedSha: 'bbb222',
        pushedAt: 200
      })
    })

    it('returns false for an unknown row', () => {
      expect(repo.recordPush(999, push)).toBe(false)
    })

    it('reads null for rows created before migration 0018', () => {
      const old = join(dir(), 'old-migrations-0018')
      cpSync(realMigrations, old, { recursive: true })
      const journalPath = join(old, 'meta', '_journal.json')
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { tag: string }[]
      }
      journal.entries = journal.entries.filter((e) => e.tag < '0018')
      writeFileSync(journalPath, JSON.stringify(journal))
      const dbPath = join(dir(), 'legacy-0018.db')
      const legacy = openDatabase({ dbPath, migrationsFolder: old })
      legacy.sqlite.exec(
        `INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES ('g1','g','g',1,1);
         INSERT INTO sessions (id, group_id, name, mode, worker_limit, status, created_at, last_active_at) VALUES ('s1','g1','s1','plan_first',3,'active',1,1);
         INSERT INTO session_projects (session_id, project_path, project_name) VALUES ('s1','/r','r');`
      )
      legacy.sqlite.close()
      const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
      const rows = new SessionProjectsRepo(upgraded.db).listBySession('s1')
      upgraded.sqlite.close()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        pushedRemote: null,
        pushedBranch: null,
        pushedSha: null,
        pushedAt: null
      })
    })
  })
})
