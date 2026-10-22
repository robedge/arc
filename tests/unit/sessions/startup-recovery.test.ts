import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { AttentionRepo } from '../../../src/main/db/repositories/attention-repo'
import { EventsRepo } from '../../../src/main/db/repositories/events-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { WorkersRepo } from '../../../src/main/db/repositories/workers-repo'
import type { WorkerStatus } from '../../../src/main/db/schema'
import type { AttentionRequestRow } from '../../../src/main/db/repositories/attention-repo'
import { answerNote } from '../../../src/main/sessions/attention-coordinator'
import { recoverAtStartup } from '../../../src/main/sessions/startup-recovery'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let workers: WorkersRepo
let messages: MessagesRepo
let events: EventsRepo
let attention: AttentionRepo

function addWorker(id: string, status: WorkerStatus): void {
  workers.insert({
    id,
    sessionId: 's1',
    number: workers.nextNumber('s1'),
    slug: id,
    task: 't',
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
  messages = new MessagesRepo(opened.db)
  events = new EventsRepo(opened.db)
  attention = new AttentionRepo(opened.db)
  addWorker('a', 'working')
  addWorker('b', 'starting')
  addWorker('c', 'needs_approval')
  addWorker('d', 'has_question')
  messages.append({
    sessionId: 's1',
    role: 'brain',
    content: 'part',
    state: 'streaming',
    createdAt: 1,
    updatedAt: 1
  })
})

afterEach(() => {
  opened.sqlite.close()
})

const deps = () => ({
  db: opened.db,
  workersRepo: workers,
  attentionRepo: attention,
  messagesRepo: messages,
  eventsRepo: events,
  now: 99
})

describe('recoverAtStartup', () => {
  it('stops starting/working as crash, keeps waiting workers and logs one event per stopped worker', () => {
    expect(recoverAtStartup(deps())).toEqual({ workers: 2, messages: 1 })
    const byId = Object.fromEntries(workers.listBySession('s1').map((w) => [w.id, w]))
    expect(byId['a']).toMatchObject({ status: 'stopped', stoppedBy: 'crash' })
    expect(byId['b']).toMatchObject({ status: 'stopped', stoppedBy: 'crash' })
    expect(byId['c']?.status).toBe('needs_approval')
    expect(byId['d']?.status).toBe('has_question')
    expect(messages.latest('s1', 5)[0]?.state).toBe('stopped')
    const log = events.page('s1', null, 10)
    expect(log.map((e) => e.text)).toEqual([
      'Stopped when Arc closed unexpectedly',
      'Stopped when Arc closed unexpectedly'
    ])
    expect(log.map((e) => e.workerId).sort()).toEqual(['a', 'b'])
  })

  it('pauses a controlled worker instead of stopping it, with no stopped event', () => {
    addWorker('e', 'working')
    addWorker('f', 'starting')
    workers.beginControl('e', 'active', 5)
    workers.beginControl('f', 'paused', 5)
    expect(recoverAtStartup(deps())).toEqual({ workers: 2, messages: 1 })
    expect(workers.get('e')).toMatchObject({ status: 'working', userControl: 'paused' })
    expect(workers.get('f')).toMatchObject({ status: 'starting', userControl: 'paused' })
    expect(events.page('s1', null, 10).map((x) => x.workerId)).not.toContain('e')
    expect(events.page('s1', null, 10).map((x) => x.workerId)).not.toContain('f')
  })

  it('is one transaction: a failure leaves everything as it was', () => {
    const failing = {
      ...deps(),
      eventsRepo: {
        append: () => {
          throw new Error('disk full')
        }
      }
    }
    expect(() => recoverAtStartup(failing)).toThrow('disk full')
    expect(workers.get('a')?.status).toBe('working')
    expect(messages.latest('s1', 5)[0]?.state).toBe('streaming')
  })

  describe('pending AskUserQuestion rows', () => {
    const question = (id: string, workerId: string, toolName: string | null = 'AskUserQuestion') =>
      attention.create({
        id,
        sessionId: 's1',
        workerId,
        source: 'worker',
        kind: 'question',
        action: null,
        reason: null,
        question: 'Which library?',
        toolName,
        toolInputJson: JSON.stringify({ questions: [] }),
        toolUseId: 'toolu_1',
        category: null,
        mustEscalate: true,
        escalated: true,
        brainNote: null,
        status: 'pending',
        answer: null,
        delivered: false,
        createdAt: 5,
        resolvedAt: null
      })

    it('cancels them, keeps them undelivered and stops the waiting worker so Continue resumes it', () => {
      question('q1', 'd')
      recoverAtStartup(deps())
      expect(attention.get('q1')).toMatchObject({
        status: 'cancelled',
        delivered: false,
        resolvedAt: 99
      })
      expect(attention.listPending('s1')).toEqual([])
      expect(attention.listUndelivered('s1', 'd').map((r) => r.id)).toEqual(['q1'])
      expect(workers.get('d')).toMatchObject({ status: 'stopped', stoppedBy: 'crash' })
      expect(events.page('s1', null, 10).map((e) => e.workerId)).toContain('d')
      expect(answerNote(attention.get('q1') as AttentionRequestRow)).toBe(
        'Your question was cancelled when Arc closed; ask it again if you still need the answer.'
      )
    })

    it('cancels the question of a controlled worker but keeps the worker, paused', () => {
      workers.beginControl('d', 'active', 5)
      question('q1', 'd')
      attention.rerouteToTerminal('d')
      recoverAtStartup(deps())
      expect(attention.get('q1')?.status).toBe('cancelled')
      expect(workers.get('d')).toMatchObject({
        status: 'has_question',
        stoppedBy: null,
        userControl: 'paused'
      })
    })

    it('keeps the terminal-routed requests of a controlled worker in the terminal', () => {
      workers.beginControl('c', 'active', 5)
      question('q2', 'c', null)
      attention.rerouteToTerminal('c')
      recoverAtStartup(deps())
      expect(attention.get('q2')).toMatchObject({ status: 'pending', route: 'terminal' })
      expect(workers.get('c')).toMatchObject({ status: 'needs_approval', userControl: 'paused' })
    })

    it('leaves other pending requests and a worker that still has one alone', () => {
      question('q1', 'd')
      question('q2', 'd', null)
      question('q3', 'c')
      recoverAtStartup(deps())
      expect(attention.get('q1')?.status).toBe('cancelled')
      expect(attention.get('q2')?.status).toBe('pending')
      expect(workers.get('d')?.status).toBe('has_question')
      // The worker waiting on an approval is not a question waiter; only its row is cancelled.
      expect(attention.get('q3')?.status).toBe('cancelled')
      expect(workers.get('c')?.status).toBe('needs_approval')
    })
  })
})
