// @spec: 013-session-branches-on-demand
// @regression
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { BranchQuestionsRepo } from '../../../src/main/db/repositories/branch-questions-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()

function migrationsUpTo(lastTag: string, dest: string): string {
  cpSync(realMigrations, dest, { recursive: true })
  const journalPath = join(dest, 'meta', '_journal.json')
  mkdirSync(join(dest, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] }
  const cut = journal.entries.findIndex((e) => e.tag === lastTag)
  journal.entries = journal.entries.slice(0, cut + 1)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dest
}

function seedSession(s: OpenedDatabase['sqlite'], id: string): void {
  s.prepare(
    `INSERT OR IGNORE INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','G','g',1,1)`
  ).run()
  s.prepare(
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
     VALUES (?,'g1','Sess','autonomous',2,'opus','sonnet','active',1,50)`
  ).run(id)
}

function seedProject(s: OpenedDatabase['sqlite'], sessionId: string, name: string): number {
  const r = s
    .prepare(`INSERT INTO session_projects (session_id, project_path, project_name) VALUES (?,?,?)`)
    .run(sessionId, `/r/${name}`, name)
  return Number(r.lastInsertRowid)
}

describe('migration 0031_branch_questions', () => {
  it('adds the table on a populated 0030 database and keeps existing rows', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({
      dbPath,
      migrationsFolder: migrationsUpTo('0030_message_attachments', join(dir(), 'm-0030'))
    })
    seedSession(old.sqlite, 's1')
    const spId = seedProject(old.sqlite, 's1', 'web')
    old.sqlite.close()

    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT count(*) AS n FROM session_projects').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT count(*) AS n FROM branch_questions').get()).toEqual({ n: 0 })
    new BranchQuestionsRepo(opened.db).openFor('s1', spId, 10)
    expect(s.prepare('SELECT count(*) AS n FROM branch_questions').get()).toEqual({ n: 1 })
    s.close()
  })
})

describe('BranchQuestionsRepo', () => {
  let opened: OpenedDatabase
  let repo: BranchQuestionsRepo
  let web: number
  let api: number
  let other: number
  beforeEach(() => {
    opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
    seedSession(opened.sqlite, 's1')
    seedSession(opened.sqlite, 's2')
    web = seedProject(opened.sqlite, 's1', 'web')
    api = seedProject(opened.sqlite, 's1', 'api')
    other = seedProject(opened.sqlite, 's2', 'web')
    repo = new BranchQuestionsRepo(opened.db)
  })
  afterEach(() => opened.sqlite.close())

  const rows = (): number =>
    (opened.sqlite.prepare('SELECT count(*) AS n FROM branch_questions').get() as { n: number }).n

  it('allows one pending question per session project', () => {
    const first = repo.openFor('s1', web, 10)
    const again = repo.openFor('s1', web, 20)
    expect(again.id).toBe(first.id)
    expect(rows()).toBe(1)
    expect(() =>
      opened.sqlite
        .prepare(
          `INSERT INTO branch_questions (id,session_id,session_project_id,status,created_at)
           VALUES ('x','s1',?,'pending',30)`
        )
        .run(web)
    ).toThrow(/UNIQUE/)
  })

  it('allows a new question once the earlier one is resolved or cancelled', () => {
    const first = repo.openFor('s1', web, 10)
    expect(repo.resolve(first.id, 'stash', 11)).toBe(true)
    const second = repo.openFor('s1', web, 12)
    expect(second.id).not.toBe(first.id)
    expect(repo.cancel(second.id, 13)).toBe(true)
    expect(repo.openFor('s1', web, 14).status).toBe('pending')
    expect(rows()).toBe(3)
  })

  it('lists and counts pending questions per session and overall', () => {
    const q1 = repo.openFor('s1', web, 10)
    const q2 = repo.openFor('s1', api, 20)
    repo.openFor('s2', other, 30)
    expect(repo.listPending('s1').map((q) => q.id)).toEqual([q1.id, q2.id])
    expect(repo.countPending('s1')).toBe(2)
    expect(repo.countPending('s2')).toBe(1)
    expect(repo.countPendingAll()).toBe(3)
    repo.resolve(q1.id, 'commit', 40)
    expect(repo.countPending('s1')).toBe(1)
    expect(repo.countPendingAll()).toBe(2)
    expect(repo.getPendingFor(web)).toBeUndefined()
    expect(repo.getPendingFor(api)?.id).toBe(q2.id)
  })

  it('stores the choice and time on resolve, and refuses a second resolve', () => {
    const q = repo.openFor('s1', web, 10)
    expect(repo.resolve(q.id, 'carry', 50)).toBe(true)
    expect(repo.resolve(q.id, 'skip', 60)).toBe(false)
    expect(repo.resolve('nope', 'skip', 60)).toBe(false)
    expect(
      opened.sqlite.prepare('SELECT status,choice,resolved_at AS r FROM branch_questions').get()
    ).toEqual({
      status: 'answered',
      choice: 'carry',
      r: 50
    })
  })

  it('cancel only touches an open question', () => {
    const q = repo.openFor('s1', web, 10)
    expect(repo.cancel(q.id, 20)).toBe(true)
    expect(repo.cancel(q.id, 30)).toBe(false)
    const a = repo.openFor('s1', api, 10)
    repo.resolve(a.id, 'stash', 11)
    expect(repo.cancel(a.id, 30)).toBe(false)
    expect(repo.countPendingAll()).toBe(0)
  })

  it('reopens an answered question with a message and clears the choice', () => {
    const q = repo.openFor('s1', web, 10)
    repo.resolve(q.id, 'carry', 11)
    expect(repo.reopenWithMessage(q.id, 'clashes with dev')).toBe(true)
    const open = repo.getPendingFor(web)
    expect(open).toMatchObject({
      id: q.id,
      choice: null,
      resolvedAt: null,
      message: 'clashes with dev'
    })
  })

  it('does not reopen a cancelled or missing question, or one that has a newer open question', () => {
    const q = repo.openFor('s1', web, 10)
    repo.resolve(q.id, 'carry', 11)
    const newer = repo.openFor('s1', web, 12)
    expect(repo.reopenWithMessage(q.id, 'm')).toBe(false)
    expect(repo.getPendingFor(web)?.id).toBe(newer.id)
    repo.cancel(newer.id, 13)
    expect(repo.reopenWithMessage(newer.id, 'm')).toBe(false)
    expect(repo.reopenWithMessage('nope', 'm')).toBe(false)
  })

  it('deletes its questions with the session', () => {
    repo.openFor('s1', web, 10)
    repo.openFor('s2', other, 10)
    opened.sqlite.prepare(`DELETE FROM sessions WHERE id='s1'`).run()
    expect(rows()).toBe(1)
    expect(repo.countPending('s1')).toBe(0)
  })

  it('deletes its questions with the session project', () => {
    repo.openFor('s1', web, 10)
    repo.openFor('s1', api, 10)
    opened.sqlite.prepare(`DELETE FROM session_projects WHERE id=?`).run(web)
    expect(rows()).toBe(1)
    expect(repo.getPendingFor(api)).toBeDefined()
  })

  it('reads a question by id and finds the newest answered one of a project', () => {
    const first = repo.openFor('s1', web, 10)
    expect(repo.getById(first.id)?.status).toBe('pending')
    expect(repo.getById('nope')).toBeUndefined()
    expect(repo.lastAnsweredFor(web)).toBeUndefined()
    repo.resolve(first.id, 'stash', 11)
    const second = repo.openFor('s1', web, 12)
    expect(repo.lastAnsweredFor(web)?.id).toBe(first.id)
    repo.resolve(second.id, 'carry', 13)
    expect(repo.lastAnsweredFor(web)?.choice).toBe('carry')
    expect(repo.lastAnsweredFor(api)).toBeUndefined()
  })
})
