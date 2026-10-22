import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MergesRepo } from '../../../src/main/db/repositories/merges-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let workers: WorkersRepo
let projects: ProjectsRepo
let merges: MergesRepo

function addWorker(id: string, sessionId: string, number: number): void {
  workers.insert({
    id,
    sessionId,
    number,
    slug: id,
    task: 't',
    projectIdsJson: '[]',
    model: 'sonnet',
    status: 'done',
    createdAt: 1,
    updatedAt: 1
  })
}

function record(
  id: string,
  sessionId: string,
  workerId: string | null,
  mergedAt: number,
  extra: Partial<Parameters<MergesRepo['record']>[0]> = {}
): void {
  merges.record({
    id,
    sessionId,
    workerId,
    result: 'clean',
    filesJson: '["a.ts"]',
    mergedAt,
    ...extra
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
  for (const id of ['s1', 's2']) {
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
  workers = new WorkersRepo(opened.db)
  projects = new ProjectsRepo(opened.db)
  merges = new MergesRepo(opened.db)
  addWorker('w1', 's1', 1)
  addWorker('w2', 's1', 2)
  projects.insert({ id: 'p1', path: '/p1', displayName: 'p1', createdAt: 1 })
})

afterEach(() => {
  opened.sqlite.close()
})

describe('MergesRepo', () => {
  it('records and lists by session and worker in merge order', () => {
    record('m2', 's1', 'w1', 20, { result: 'resolved', notes: 'kept both', mergeSha: 'abc' })
    record('m1', 's1', 'w1', 10, { result: 'failed', conflictFilesJson: '["a.ts"]' })
    record('m3', 's1', 'w2', 30)
    record('m4', 's2', null, 5)

    expect(merges.listBySession('s1').map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(merges.listByWorker('w1').map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(merges.latestForWorker('w1')?.id).toBe('m2')
    expect(merges.latestForWorker('w1')).toMatchObject({ result: 'resolved', mergeSha: 'abc' })
    expect(merges.latestForWorker('nope')).toBeUndefined()
  })

  it('cascades when the session is deleted', () => {
    record('m1', 's1', 'w1', 10)
    sessions.delete('s1')
    expect(merges.listBySession('s1')).toEqual([])
  })

  it('sets project_id to null when the project is deleted', () => {
    record('m1', 's1', 'w1', 10, { projectId: 'p1' })
    expect(projects.deleteIfOrphan('p1')).toBe(true)
    expect(merges.listBySession('s1')[0]?.projectId).toBeNull()
  })
})
