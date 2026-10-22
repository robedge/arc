import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { ulid } from '../../../src/main/db/ids'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
import { ReviewNotesRepo } from '../../../src/main/db/repositories/review-notes-repo'
import type { NewReviewNoteRow } from '../../../src/main/db/repositories/review-notes-repo'
import { SessionProjectsRepo } from '../../../src/main/db/repositories/session-projects-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import { projects } from '../../../src/main/db/schema'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let sessions: SessionsRepo
let messages: MessagesRepo
let repo: ReviewNotesRepo
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

function note(sessionProjectId: number, over: Partial<NewReviewNoteRow> = {}): NewReviewNoteRow {
  return {
    id: ulid(),
    sessionProjectId,
    path: 'src/a.ts',
    side: 'new',
    line: 3,
    lineText: 'const x = 1',
    body: 'why?',
    createdAt: 10,
    updatedAt: 10,
    ...over
  }
}

function addMessage(sessionId: string): number {
  return messages.append({
    sessionId,
    role: 'user',
    content: 'notes',
    state: 'complete',
    createdAt: 1,
    updatedAt: 1
  }).id
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
  messages = new MessagesRepo(opened.db)
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
  repo = new ReviewNotesRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

describe('ReviewNotesRepo', () => {
  it('creates a draft and lists by session project, optionally by path', () => {
    const created = repo.create(note(spA))
    expect(created).toMatchObject({ state: 'draft', messageId: null, body: 'why?' })
    repo.create(note(spA, { path: 'src/b.ts' }))
    repo.create(note(spB))
    expect(repo.listBySessionProject(spA)).toHaveLength(2)
    expect(repo.listBySessionProject(spA, 'src/b.ts').map((n) => n.path)).toEqual(['src/b.ts'])
    expect(repo.listBySessionProject(spOther)).toEqual([])
  })

  it('listBySession joins the project id and listDrafts excludes sent notes', () => {
    const a = repo.create(note(spA, { createdAt: 1 }))
    repo.create(note(spB, { createdAt: 2 }))
    repo.create(note(spOther))
    repo.markSent([a.id], addMessage('s1'))
    expect(repo.listBySession('s1').map((n) => [n.projectId, n.state])).toEqual([
      ['p1', 'sent'],
      ['p2', 'draft']
    ])
    expect(repo.listDrafts('s1').map((n) => n.projectId)).toEqual(['p2'])
  })

  it('updates and deletes drafts', () => {
    const n = repo.create(note(spA))
    expect(repo.update(n.id, 'new body', 50)).toBe(true)
    expect(repo.listBySessionProject(spA)[0]).toMatchObject({ body: 'new body', updatedAt: 50 })
    expect(repo.delete(n.id)).toBe(true)
    expect(repo.listBySessionProject(spA)).toEqual([])
  })

  it('refuses to update or delete sent or missing notes', () => {
    const n = repo.create(note(spA))
    repo.markSent([n.id], addMessage('s1'))
    expect(repo.update(n.id, 'changed')).toBe(false)
    expect(repo.delete(n.id)).toBe(false)
    expect(repo.listBySessionProject(spA)[0]).toMatchObject({ body: 'why?', state: 'sent' })
    expect(repo.update('nope', 'x')).toBe(false)
    expect(repo.delete('nope')).toBe(false)
  })

  it('markSent flips drafts with the message id in one go', () => {
    const a = repo.create(note(spA))
    const b = repo.create(note(spB))
    const mid = addMessage('s1')
    expect(repo.markSent([a.id, b.id], mid, 99)).toBe(true)
    for (const n of repo.listBySession('s1')) {
      expect(n).toMatchObject({ state: 'sent', messageId: mid, updatedAt: 99 })
    }
  })

  it('markSent is all-or-nothing when one id is not a draft', () => {
    const a = repo.create(note(spA))
    const b = repo.create(note(spA, { path: 'b.ts' }))
    const first = addMessage('s1')
    repo.markSent([b.id], first)
    expect(repo.markSent([a.id, b.id], addMessage('s1'))).toBe(false)
    expect(repo.markSent([a.id, 'missing'], first)).toBe(false)
    const byId = new Map(repo.listBySessionProject(spA).map((n) => [n.id, n]))
    expect(byId.get(a.id)).toMatchObject({ state: 'draft', messageId: null })
    expect(byId.get(b.id)).toMatchObject({ state: 'sent', messageId: first })
  })

  it('countDrafts counts only this session drafts', () => {
    const a = repo.create(note(spA))
    repo.create(note(spB))
    repo.create(note(spOther))
    expect(repo.countDrafts('s1')).toBe(2)
    repo.markSent([a.id], addMessage('s1'))
    expect(repo.countDrafts('s1')).toBe(1)
    expect(repo.countDrafts('none')).toBe(0)
  })

  it('enforces CHECK constraints', () => {
    expect(() => repo.create(note(spA, { side: 'mid' as 'old' }))).toThrow(/CHECK/)
    expect(() => repo.create(note(spA, { line: 0 }))).toThrow(/CHECK/)
    expect(() => repo.create(note(spA, { body: '' }))).toThrow(/CHECK/)
    expect(() => repo.create(note(spA, { body: 'x'.repeat(4001) }))).toThrow(/CHECK/)
    expect(() => repo.create(note(spA, { lineText: 'x'.repeat(501) }))).toThrow(/CHECK/)
    expect(() => repo.create(note(spA, { state: 'other' as 'draft' }))).toThrow(/CHECK/)
    expect(
      repo.create(note(spA, { body: 'x'.repeat(4000), lineText: 'x'.repeat(500) }))
    ).toBeTruthy()
  })

  it('cascades when the session is deleted', () => {
    repo.create(note(spA))
    repo.create(note(spOther))
    opened.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(repo.listBySessionProject(spA)).toEqual([])
    expect(repo.listBySessionProject(spOther)).toHaveLength(1)
  })

  it('sets message_id to null when the message row is deleted', () => {
    const n = repo.create(note(spA))
    const mid = addMessage('s1')
    repo.markSent([n.id], mid)
    opened.sqlite.prepare('DELETE FROM messages WHERE id = ?').run(mid)
    expect(repo.listBySessionProject(spA)[0]).toMatchObject({ state: 'sent', messageId: null })
  })
})
