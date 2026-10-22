import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let attention: AttentionRepo
let seq = 0

function addSession(id: string, groupId: string): void {
  sessions.create({
    id,
    groupId,
    name: id,
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
}

function add(
  sessionId: string,
  extra: Partial<Parameters<AttentionRepo['create']>[0]> = {}
): string {
  const id = `a${++seq}`
  attention.create({
    id,
    sessionId,
    source: 'worker',
    kind: 'permission',
    action: 'Run rm -rf build',
    createdAt: seq,
    ...extra
  })
  return id
}

beforeEach(() => {
  seq = 0
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  const groups = new GroupsRepo(opened.db)
  for (const id of ['g1', 'g2', 'g3']) {
    groups.insert({ id, name: id, nameKey: id, createdAt: 1, updatedAt: 1 })
  }
  sessions = new SessionsRepo(opened.db)
  attention = new AttentionRepo(opened.db)
  addSession('s1', 'g1')
  addSession('s2', 'g1')
  addSession('s3', 'g2')
  addSession('s4', 'g3')
})

afterEach(() => {
  opened.sqlite.close()
})

describe('AttentionRepo', () => {
  it('creates with defaults and reads back', () => {
    const id = add('s1', { toolName: 'Bash', toolInputJson: '{"command":"ls"}', toolUseId: 'tu1' })
    const row = attention.get(id)
    expect(row).toMatchObject({
      status: 'pending',
      mustEscalate: false,
      escalated: false,
      delivered: false,
      toolInputJson: '{"command":"ls"}',
      resolvedAt: null,
      workerId: null
    })
    expect(attention.get('nope')).toBeUndefined()
  })

  it('lists pending in creation order and drops resolved ones', () => {
    const a = add('s1')
    const b = add('s1', { kind: 'question', action: null, question: 'Which db?' })
    add('s2')
    expect(attention.listPending('s1').map((r) => r.id)).toEqual([a, b])
    attention.resolve(a, 'approved', null, 10)
    expect(attention.listPending('s1').map((r) => r.id)).toEqual([b])
  })

  it('markEscalated and listPendingEscalated only show passed-on requests', () => {
    const a = add('s1')
    const b = add('s1', { mustEscalate: true, escalated: true })
    expect(attention.listPendingEscalated('s1').map((r) => r.id)).toEqual([b])
    attention.markEscalated(a, 'unsure about this')
    expect(attention.listPendingEscalated('s1').map((r) => r.id)).toEqual([a, b])
    expect(attention.get(a)?.brainNote).toBe('unsure about this')
  })

  it('resolve sets status, answer and time, and refuses a second resolve', () => {
    const id = add('s1', { kind: 'question', action: null, question: 'q?' })
    expect(attention.resolve(id, 'answered', 'blue', 50)).toBe(true)
    expect(attention.get(id)).toMatchObject({ status: 'answered', answer: 'blue', resolvedAt: 50 })
    expect(attention.resolve(id, 'denied', null, 60)).toBe(false)
    expect(attention.get(id)?.status).toBe('answered')
  })

  it('listUndelivered returns resolved, undelivered requests, optionally per worker', () => {
    opened.sqlite.exec(
      `INSERT INTO workers (id, session_id, number, slug, task, project_ids_json, model, status, created_at, updated_at)
       VALUES ('w1','s1',1,'w','t','[]','sonnet','working',1,1),('w2','s1',2,'w','t','[]','sonnet','working',1,1)`
    )
    const a = add('s1', { workerId: 'w1' })
    const b = add('s1', { workerId: 'w2' })
    const c = add('s1', { workerId: 'w1' })
    attention.resolve(a, 'approved', null, 5)
    attention.resolve(b, 'denied', null, 6)
    expect(attention.listUndelivered('s1').map((r) => r.id)).toEqual([a, b])
    expect(attention.listUndelivered('s1', 'w1').map((r) => r.id)).toEqual([a])
    attention.markDelivered(a)
    expect(attention.listUndelivered('s1').map((r) => r.id)).toEqual([b])
    expect(attention.get(c)?.status).toBe('pending')
  })

  it('counts pending escalated by session', () => {
    add('s1', { escalated: true })
    add('s1', { escalated: true })
    add('s1')
    const done = add('s1', { escalated: true })
    attention.resolve(done, 'approved', null, 9)
    expect(attention.countPendingEscalatedBySession('s1')).toBe(2)
    expect(attention.countPendingEscalatedBySession('s2')).toBe(0)
  })

  it('counts pending escalated by group across sessions, omitting empty groups', () => {
    add('s1', { escalated: true })
    add('s2', { escalated: true })
    add('s3', { escalated: true })
    add('s3', { escalated: true })
    add('s4')
    const resolved = add('s3', { escalated: true })
    attention.resolve(resolved, 'denied', null, 9)
    expect(attention.countPendingEscalatedByGroup()).toEqual({ g1: 2, g2: 2 })
  })

  it('rejects a row with neither action nor question', () => {
    expect(() => add('s1', { action: null, question: null })).toThrow(/CHECK/)
  })

  it('cascades with the session and nulls worker_id when the worker goes', () => {
    opened.sqlite.exec(
      `INSERT INTO workers (id, session_id, number, slug, task, project_ids_json, model, status, created_at, updated_at)
       VALUES ('w1','s1',1,'w','t','[]','sonnet','working',1,1)`
    )
    const a = add('s1', { workerId: 'w1' })
    opened.sqlite.exec(`DELETE FROM workers WHERE id='w1'`)
    expect(attention.get(a)?.workerId).toBeNull()
    sessions.delete('s1')
    expect(attention.get(a)).toBeUndefined()
  })

  it('uses the partial index for pending lookups', () => {
    for (let i = 0; i < 30; i++) {
      const id = add(i % 2 === 0 ? 's1' : 's2')
      if (i % 5 !== 0) attention.resolve(id, 'approved', null, 100 + i)
    }
    opened.sqlite.exec('ANALYZE')
    const plan = opened.sqlite
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM attention_requests WHERE session_id = ? AND status = 'pending'`
      )
      .all('s1') as { detail: string }[]
    expect(plan.map((p) => p.detail).join('\n')).toContain('attention_requests_pending_idx')
  })
})
