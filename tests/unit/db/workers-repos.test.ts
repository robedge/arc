import { cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { CommitsRepo } from '../../../src/main/db/repositories/commits-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { PlansRepo } from '../../../src/main/db/repositories/plans-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import { WorktreesRepo } from '../../../src/main/db/repositories/worktrees-repo'
import type { WorkerStatus } from '../../../src/main/db/schema'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let plans: PlansRepo
let workers: WorkersRepo
let worktrees: WorktreesRepo
let commits: CommitsRepo

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

function addWorker(id: string, sessionId: string, status: WorkerStatus = 'queued'): void {
  workers.insert({
    id,
    sessionId,
    number: workers.nextNumber(sessionId),
    slug: id,
    task: 'do it',
    projectIdsJson: '[]',
    model: 'sonnet',
    status,
    createdAt: 1,
    updatedAt: 1
  })
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
  plans = new PlansRepo(opened.db)
  workers = new WorkersRepo(opened.db)
  worktrees = new WorktreesRepo(opened.db)
  commits = new CommitsRepo(opened.db)
  addSession('s1')
  addSession('s2')
})

afterEach(() => {
  opened.sqlite.close()
})

describe('WorkersRepo command', () => {
  const base = {
    sessionId: 's1',
    slug: 'w',
    task: 'do it',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'queued' as const,
    createdAt: 1,
    updatedAt: 1
  }

  it('create with command persists and reads back', () => {
    const row = workers.insert({ ...base, id: 'wc', number: 1, command: '/awos:spec add login' })
    expect(row.command).toBe('/awos:spec add login')
    expect(workers.get('wc')?.command).toBe('/awos:spec add login')
    expect(workers.listBySession('s1')[0]?.command).toBe('/awos:spec add login')
    expect(workers.listAllBySession('s1')[0]?.command).toBe('/awos:spec add login')
  })

  it('create without command stores null', () => {
    const row = workers.insert({ ...base, id: 'wn', number: 1 })
    expect(row.command).toBeNull()
    expect(workers.get('wn')?.command).toBeNull()
  })

  it('reads null for rows created before migration 0021', () => {
    const old = join(dir(), 'old-migrations')
    cpSync(realMigrations, old, { recursive: true })
    const journalPath = join(old, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] }
    // drizzle applies by last-applied timestamp, so drop 0021 and every later migration
    journal.entries = journal.entries.filter((e) => e.tag < '0021')
    writeFileSync(journalPath, JSON.stringify(journal))
    const dbPath = join(dir(), 'legacy.db')
    const legacy = openDatabase({ dbPath, migrationsFolder: old })
    legacy.sqlite.exec(
      `INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES ('g1','g','g',1,1);
       INSERT INTO sessions (id, group_id, name, mode, worker_limit, status, created_at, last_active_at) VALUES ('s1','g1','s1','plan_first',3,'active',1,1);
       INSERT INTO workers (id, session_id, number, slug, task, project_ids_json, model, status, created_at, updated_at) VALUES ('w1','s1',1,'w1','t','[]','sonnet','queued',1,1);`
    )
    legacy.sqlite.close()
    const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const row = new WorkersRepo(upgraded.db).get('w1')
    upgraded.sqlite.close()
    expect(row?.command).toBeNull()
  })
})

describe('WorkersRepo', () => {
  it('nextNumber counts up per session', () => {
    expect(workers.nextNumber('s1')).toBe(1)
    addWorker('w1', 's1')
    addWorker('w2', 's1')
    expect(workers.nextNumber('s1')).toBe(3)
    expect(workers.nextNumber('s2')).toBe(1)
    expect(workers.listBySession('s1').map((w) => w.number)).toEqual([1, 2])
  })

  it('countActive counts only starting, working, needs_approval and has_question', () => {
    const statuses: WorkerStatus[] = [
      'queued',
      'starting',
      'working',
      'needs_approval',
      'has_question',
      'done',
      'merged',
      'failed',
      'stopped'
    ]
    statuses.forEach((s, i) => addWorker(`w${i}`, 's1', s))
    addWorker('other', 's2', 'working')
    expect(workers.countActive('s1')).toBe(4)
    expect(workers.countActive('s2')).toBe(1)
  })

  it('recoverInterrupted stops starting/working as crash and keeps waiting workers', () => {
    addWorker('a', 's1', 'starting')
    addWorker('b', 's1', 'working')
    addWorker('c', 's1', 'needs_approval')
    addWorker('d', 's1', 'has_question')
    addWorker('e', 's1', 'done')
    const recovered = workers.recoverInterrupted(99)
    expect(recovered.map((w) => w.id).sort()).toEqual(['a', 'b'])
    const byId = Object.fromEntries(workers.listBySession('s1').map((w) => [w.id, w]))
    expect(byId.a).toMatchObject({ status: 'stopped', stoppedBy: 'crash', updatedAt: 99 })
    expect(byId.b).toMatchObject({ status: 'stopped', stoppedBy: 'crash' })
    expect(byId.c?.status).toBe('needs_approval')
    expect(byId.d?.status).toBe('has_question')
    expect(byId.e).toMatchObject({ status: 'done', stoppedBy: null })
  })

  it('defaults to claude and records provider, fallback and session id', () => {
    addWorker('w', 's1')
    expect(workers.get('w')).toMatchObject({
      provider: 'claude',
      requestedProvider: null,
      fallbackReason: null
    })
    workers.setProvider('w', 'codex', 2)
    workers.setFallback('w', 'codex', 'codex_not_signed_in', 3)
    workers.setProviderSessionId('w', 'thread-1', 4)
    expect(workers.get('w')).toMatchObject({
      provider: 'codex',
      requestedProvider: 'codex',
      fallbackReason: 'codex_not_signed_in',
      providerSessionId: 'thread-1',
      updatedAt: 4
    })
  })

  it('setTarget moves a worker that has not started to another provider and model', () => {
    addWorker('w', 's1')
    workers.setProvider('w', 'codex', 2)
    workers.setTarget('w', 'claude', 'haiku', 3)
    expect(workers.get('w')).toMatchObject({ provider: 'claude', model: 'haiku', updatedAt: 3 })
  })

  it('setters update their columns', () => {
    addWorker('w', 's1')
    workers.setStatus('w', 'stopped', 5, 'user')
    workers.setActivity('w', 'editing', 6)
    workers.setSummary('w', 'sum', 7)
    workers.setProviderSessionId('w', 'cs', 8)
    expect(workers.get('w')).toMatchObject({
      status: 'stopped',
      stoppedBy: 'user',
      activity: 'editing',
      summary: 'sum',
      providerSessionId: 'cs',
      updatedAt: 8
    })
    workers.setFailure('w', 'boom', 9)
    expect(workers.get('w')).toMatchObject({ status: 'failed', failureReason: 'boom' })
  })

  it('cascades worker, worktree and commit rows when the session is deleted', () => {
    addWorker('w', 's1')
    plans.insert({ id: 'p', sessionId: 's1', status: 'proposed', workersJson: '[]', createdAt: 1 })
    worktrees.insert({ workerId: 'w', projectId: null, path: '/x', baseSha: 'a', headSha: 'a' })
    commits.add({ workerId: 'w', projectId: null, sha: 'c', subject: 's', committedAt: 1 })
    opened.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(workers.get('w')).toBeUndefined()
    expect(plans.get('p')).toBeUndefined()
    expect(worktrees.listByWorker('w')).toEqual([])
    expect(commits.listByWorker('w')).toEqual([])
  })
})

describe('PlansRepo', () => {
  it('chains replaced plans and returns the latest', () => {
    plans.insert({ id: 'p1', sessionId: 's1', status: 'proposed', workersJson: '[]', createdAt: 1 })
    plans.insert({ id: 'p2', sessionId: 's1', status: 'proposed', workersJson: '[]', createdAt: 2 })
    plans.markReplaced('p1', 'p2', 10)
    expect(plans.get('p1')).toMatchObject({
      status: 'replaced',
      replacedById: 'p2',
      resolvedAt: 10
    })
    expect(plans.latest('s1')?.id).toBe('p2')
    plans.setStatus('p2', 'approved', 11)
    expect(plans.get('p2')).toMatchObject({ status: 'approved', resolvedAt: 11 })
    expect(plans.latest('s2')).toBeUndefined()
  })
})

describe('WorktreesRepo and CommitsRepo', () => {
  it('updates head_sha and marks a worktree removed', () => {
    addWorker('w', 's1')
    const wt = worktrees.insert({
      workerId: 'w',
      projectId: null,
      path: '/x',
      baseSha: 'a',
      headSha: 'a'
    })
    worktrees.setHeadSha(wt.id, 'b')
    worktrees.markRemoved(wt.id, 50)
    expect(worktrees.listByWorker('w')[0]).toMatchObject({
      headSha: 'b',
      baseSha: 'a',
      removedAt: 50
    })
    commits.add({ workerId: 'w', projectId: null, sha: 'b', subject: 'one', committedAt: 2 })
    commits.add({ workerId: 'w', projectId: null, sha: 'c', subject: 'two', committedAt: 3 })
    expect(commits.listByWorker('w').map((c) => c.subject)).toEqual(['one', 'two'])
  })
})

describe('WorkersRepo user control', () => {
  it('beginControl sets the overlay and resets counters; endControl clears them', () => {
    addWorker('w1', 's1', 'working')
    workers.beginControl('w1', 'active', 100)
    expect(workers.get('w1')).toMatchObject({
      userControl: 'active',
      controlStartedAt: 100,
      controlUserMessages: 0,
      controlLastMessage: null,
      status: 'working'
    })
    workers.recordControlMessage('w1', 'hello', 110)
    workers.endControl('w1', 120)
    expect(workers.get('w1')).toMatchObject({
      userControl: null,
      controlStartedAt: null,
      controlUserMessages: 0,
      controlLastMessage: null
    })
  })

  it('setControl switches active/paused and keeps the counters', () => {
    addWorker('w1', 's1', 'working')
    workers.beginControl('w1', 'active', 100)
    workers.recordControlMessage('w1', 'one', 101)
    workers.setControl('w1', 'paused', 102)
    expect(workers.get('w1')).toMatchObject({
      userControl: 'paused',
      controlStartedAt: 100,
      controlUserMessages: 1
    })
  })

  it('recordControlMessage counts lines and cuts the excerpt to 200 characters', () => {
    addWorker('w1', 's1', 'working')
    workers.beginControl('w1', 'active', 100)
    workers.recordControlMessage('w1', 'first', 101)
    workers.recordControlMessage('w1', 'x'.repeat(250), 102)
    const row = workers.get('w1')
    expect(row?.controlUserMessages).toBe(2)
    expect(row?.controlLastMessage).toBe('x'.repeat(200))
  })

  it('listControlled returns only the session controlled, non-removed workers', () => {
    addWorker('w1', 's1', 'working')
    addWorker('w2', 's1', 'working')
    addWorker('w3', 's1', 'working')
    addWorker('w4', 's2', 'working')
    workers.beginControl('w1', 'active', 1)
    workers.beginControl('w3', 'paused', 1)
    workers.beginControl('w4', 'active', 1)
    workers.markRemoved('w3', 2)
    expect(workers.listControlled('s1').map((w) => w.id)).toEqual(['w1'])
  })

  it('pauseAllActiveControl pauses active rows only and returns them as they were', () => {
    addWorker('w1', 's1', 'working')
    addWorker('w2', 's1', 'working')
    addWorker('w3', 's2', 'working')
    workers.beginControl('w1', 'active', 1)
    workers.beginControl('w2', 'paused', 1)
    const before = workers.pauseAllActiveControl(50)
    expect(before.map((w) => [w.id, w.userControl])).toEqual([['w1', 'active']])
    expect(workers.get('w1')?.userControl).toBe('paused')
    expect(workers.get('w2')?.userControl).toBe('paused')
    expect(workers.get('w3')?.userControl).toBeNull()
  })

  it('upgrades an existing database: old rows get no control and route queue', () => {
    const old = join(dir(), 'old-migrations-22')
    cpSync(realMigrations, old, { recursive: true })
    const journalPath = join(old, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] }
    journal.entries = journal.entries.filter((e) => e.tag < '0022')
    writeFileSync(journalPath, JSON.stringify(journal))
    const dbPath = join(dir(), 'legacy22.db')
    const legacy = openDatabase({ dbPath, migrationsFolder: old })
    legacy.sqlite.exec(
      `INSERT INTO groups (id, name, name_key, created_at, updated_at) VALUES ('g1','g','g',1,1);
       INSERT INTO sessions (id, group_id, name, mode, worker_limit, status, created_at, last_active_at) VALUES ('s1','g1','s1','plan_first',3,'active',1,1);
       INSERT INTO workers (id, session_id, number, slug, task, project_ids_json, model, status, created_at, updated_at) VALUES ('w1','s1',1,'w1','t','[]','sonnet','working',1,1);
       INSERT INTO attention_requests (id, session_id, worker_id, source, kind, action, status, created_at) VALUES ('a1','s1','w1','worker','permission','x','pending',1);`
    )
    legacy.sqlite.close()
    const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const row = new WorkersRepo(upgraded.db).get('w1')
    const route = upgraded.sqlite.prepare('SELECT route FROM attention_requests').get()
    upgraded.sqlite.close()
    expect(row).toMatchObject({ userControl: null, controlUserMessages: 0 })
    expect(route).toEqual({ route: 'queue' })
  })
})

describe('WorktreesRepo control base', () => {
  function addTree(workerId: string): number {
    return worktrees.insert({
      workerId,
      projectId: null,
      path: `/${workerId}-${Math.random()}`,
      baseSha: 'a',
      headSha: 'a'
    }).id
  }

  it('records, lists and clears control bases, skipping removed worktrees', () => {
    addWorker('w1', 's1', 'working')
    addWorker('w2', 's1', 'working')
    const a = addTree('w1')
    const b = addTree('w1')
    const c = addTree('w1')
    const other = addTree('w2')
    worktrees.setControlBase(a, 'sha-a')
    worktrees.setControlBase(b, 'sha-b')
    worktrees.setControlBase(other, 'sha-o')
    worktrees.markRemoved(b, 5)
    expect(worktrees.listControlBases('w1').map((r) => [r.id, r.controlBaseSha])).toEqual([
      [a, 'sha-a']
    ])
    expect(c).toBeGreaterThan(b)
    worktrees.clearControlBase('w1')
    expect(worktrees.listControlBases('w1')).toEqual([])
    expect(worktrees.listControlBases('w2')).toHaveLength(1)
  })
})
