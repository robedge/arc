import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { HeldMessagesRepo } from '../../../src/main/db/repositories/held-messages-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let held: HeldMessagesRepo
let workers: WorkersRepo

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  new GroupsRepo(opened.db).insert({
    id: 'g1',
    name: 'g',
    nameKey: 'g',
    createdAt: 1,
    updatedAt: 1
  })
  new SessionsRepo(opened.db).create({
    id: 's1',
    groupId: 'g1',
    name: 's1',
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1
  })
  workers = new WorkersRepo(opened.db)
  for (const id of ['w1', 'w2']) {
    workers.insert({
      id,
      sessionId: 's1',
      number: workers.nextNumber('s1'),
      slug: id,
      task: 'do it',
      projectIdsJson: '[]',
      model: 'sonnet',
      status: 'working',
      createdAt: 1,
      updatedAt: 1
    })
  }
  held = new HeldMessagesRepo(opened.db)
})

afterEach(() => {
  opened.sqlite.close()
})

describe('HeldMessagesRepo', () => {
  it('lists a worker undelivered messages in the order they were enqueued', () => {
    held.enqueue('w1', 's1', 'first', 10)
    held.enqueue('w2', 's1', 'other worker', 11)
    held.enqueue('w1', 's1', 'second', 12)
    expect(held.listUndelivered('w1').map((m) => m.body)).toEqual(['first', 'second'])
  })

  it('markDelivered hides rows from the list but keeps them', () => {
    const a = held.enqueue('w1', 's1', 'a', 10)
    held.enqueue('w1', 's1', 'b', 11)
    held.markDelivered([a.id], 20)
    expect(held.listUndelivered('w1').map((m) => m.body)).toEqual(['b'])
    const row = opened.sqlite
      .prepare('SELECT delivered_at AS d FROM worker_held_messages WHERE id = ?')
      .get(a.id) as { d: number }
    expect(row.d).toBe(20)
  })

  it('markDelivered with no ids is a no-op', () => {
    held.enqueue('w1', 's1', 'a', 10)
    held.markDelivered([], 20)
    expect(held.listUndelivered('w1')).toHaveLength(1)
  })

  it('cascades when the worker is deleted', () => {
    held.enqueue('w1', 's1', 'a', 10)
    opened.sqlite.prepare('DELETE FROM workers WHERE id = ?').run('w1')
    expect(held.listUndelivered('w1')).toEqual([])
  })
})
