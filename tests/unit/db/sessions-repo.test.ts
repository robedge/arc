import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { EventsRepo } from '../../../src/main/db/repositories/events-repo'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
import { SessionsRepo } from '../../../src/main/db/repositories/sessions-repo'
import type { NewSessionRow } from '../../../src/main/db/repositories/sessions-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let groups: GroupsRepo
let sessions: SessionsRepo
let messages: MessagesRepo
let events: EventsRepo

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  groups = new GroupsRepo(opened.db)
  sessions = new SessionsRepo(opened.db)
  messages = new MessagesRepo(opened.db)
  events = new EventsRepo(opened.db)
  addGroup('g1')
})
afterEach(() => opened.sqlite.close())

function addGroup(id: string): void {
  groups.insert({ id, name: id, nameKey: id, createdAt: 1, updatedAt: 1 })
}

function sessionRow(id: string, over: Partial<NewSessionRow> = {}): NewSessionRow {
  return {
    id,
    groupId: 'g1',
    name: id,
    mode: 'plan_first',
    workerLimit: 3,
    status: 'active',
    createdAt: 1,
    lastActiveAt: 1,
    ...over
  }
}

function msg(sessionId: string, content: string) {
  return {
    sessionId,
    role: 'user' as const,
    content,
    state: 'complete' as const,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('SessionsRepo', () => {
  it('creates with defaults and lists by last_active_at desc', () => {
    sessions.create(sessionRow('a', { lastActiveAt: 10 }))
    sessions.create(sessionRow('b', { lastActiveAt: 30 }))
    sessions.create(sessionRow('c', { lastActiveAt: 20 }))
    addGroup('g2')
    sessions.create(sessionRow('x', { groupId: 'g2' }))
    expect(sessions.listByGroup('g1').map((s) => s.id)).toEqual(['b', 'c', 'a'])
    const a = sessions.getById('a')
    expect(a).toMatchObject({ model: 'auto', slug: null, brainProvider: 'claude' })
    expect(sessions.getById('nope')).toBeUndefined()
  })

  it('updates fields and touch reorders', () => {
    sessions.create(sessionRow('a', { lastActiveAt: 10 }))
    sessions.create(sessionRow('b', { lastActiveAt: 20 }))
    sessions.rename('a', 'Renamed')
    sessions.setMode('a', 'autonomous')
    sessions.setWorkerLimit('a', 5)
    sessions.setWorkersPref('a', { mode: 'provider', provider: 'codex' })
    sessions.setSlug('a', 'my-slug')
    sessions.setStatus('a', 'stopped')
    sessions.touch('a', 99)
    expect(sessions.getById('a')).toMatchObject({
      name: 'Renamed',
      mode: 'autonomous',
      workerLimit: 5,
      workersPrefJson: JSON.stringify({ mode: 'provider', provider: 'codex' }),
      slug: 'my-slug',
      status: 'stopped',
      lastActiveAt: 99
    })
    expect(sessions.listByGroup('g1').map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('enforces worker_limit 1..6', () => {
    expect(() => sessions.create(sessionRow('z', { workerLimit: 0 }))).toThrow(/CHECK/)
    expect(() => sessions.create(sessionRow('z', { workerLimit: 7 }))).toThrow(/CHECK/)
    sessions.create(sessionRow('ok', { workerLimit: 6 }))
    expect(() => sessions.setWorkerLimit('ok', 7)).toThrow(/CHECK/)
  })

  it('cascades from group delete to sessions, messages and events', () => {
    sessions.create(sessionRow('a'))
    messages.append(msg('a', 'hi'))
    events.append({ sessionId: 'a', at: 1, kind: 'k', text: 't' })
    groups.delete('g1')
    expect(sessions.getById('a')).toBeUndefined()
    expect(messages.latest('a', 10)).toEqual([])
    expect(events.latest('a', 10)).toEqual([])
  })

  it('delete removes the session and its logs', () => {
    sessions.create(sessionRow('a'))
    messages.append(msg('a', 'hi'))
    sessions.delete('a')
    expect(messages.latest('a', 10)).toEqual([])
  })
})

describe('MessagesRepo', () => {
  beforeEach(() => sessions.create(sessionRow('a')))

  it('streams then finalizes', () => {
    const m = messages.append({ ...msg('a', 'He'), role: 'brain', state: 'streaming' })
    messages.updateStreaming(m.id, 'Hello', 5)
    expect(messages.latest('a', 5)[0]).toMatchObject({
      content: 'Hello',
      state: 'streaming',
      updatedAt: 5
    })
    messages.finalize(m.id, 'Hello world', 'complete', 9)
    expect(messages.latest('a', 5)[0]).toMatchObject({
      content: 'Hello world',
      state: 'complete',
      updatedAt: 9
    })
  })

  it('pages by keyset in ascending order', () => {
    for (let i = 1; i <= 7; i++) messages.append(msg('a', `m${i}`))
    sessions.create(sessionRow('b'))
    messages.append(msg('b', 'other'))
    const first = messages.page('a', null, 3)
    expect(first.map((m) => m.content)).toEqual(['m5', 'm6', 'm7'])
    const second = messages.page('a', first[0]!.id, 3)
    expect(second.map((m) => m.content)).toEqual(['m2', 'm3', 'm4'])
    const third = messages.page('a', second[0]!.id, 3)
    expect(third.map((m) => m.content)).toEqual(['m1'])
    expect(messages.page('a', third[0]!.id, 3)).toEqual([])
  })

  it('recoverStreaming stops only streaming rows', () => {
    const s = messages.append({ ...msg('a', 'part'), role: 'brain', state: 'streaming' })
    const c = messages.append(msg('a', 'done'))
    expect(messages.recoverStreaming(50)).toBe(1)
    const rows = messages.latest('a', 5)
    expect(rows.find((r) => r.id === s.id)).toMatchObject({
      state: 'stopped',
      updatedAt: 50,
      content: 'part'
    })
    expect(rows.find((r) => r.id === c.id)?.state).toBe('complete')
    expect(messages.recoverStreaming(60)).toBe(0)
  })
})

describe('EventsRepo', () => {
  beforeEach(() => sessions.create(sessionRow('a')))

  it('appendMany inserts in order in one transaction and pages', () => {
    const rows = events.appendMany(
      [1, 2, 3, 4].map((n) => ({ sessionId: 'a', at: n, kind: 'k', text: `e${n}` }))
    )
    expect(rows.map((r) => r.text)).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(events.latest('a', 2).map((r) => r.text)).toEqual(['e3', 'e4'])
    expect(events.page('a', rows[2]!.id, 5).map((r) => r.text)).toEqual(['e1', 'e2'])
    expect(events.appendMany([])).toEqual([])
  })

  it('says whether the session has an event of a kind', () => {
    events.append({ sessionId: 'a', at: 1, kind: 'bypass-warning', text: 't' })
    expect(events.hasKind('a', 'bypass-warning')).toBe(true)
    expect(events.hasKind('a', 'other')).toBe(false)
    expect(events.hasKind('b', 'bypass-warning')).toBe(false)
  })

  it('appendMany rolls back entirely on failure', () => {
    expect(() =>
      events.appendMany([
        { sessionId: 'a', at: 1, kind: 'k', text: 'ok' },
        { sessionId: 'missing', at: 2, kind: 'k', text: 'bad' }
      ])
    ).toThrow()
    expect(events.latest('a', 5)).toEqual([])
  })
})

describe('brain_model', () => {
  it('defaults to sonnet and can be set', () => {
    sessions.create(sessionRow('a'))
    expect(sessions.getById('a')?.brainModel).toBe('sonnet')
    sessions.setBrain('a', { provider: 'codex', model: 'gpt-x' })
    expect(sessions.getById('a')).toMatchObject({ brainProvider: 'codex', brainModel: 'gpt-x' })
    expect(sessions.getById('a')?.model).toBe('auto')
  })

  it('migration 0008 gives existing sessions the sonnet default', () => {
    const old = join(dir(), 'old-migrations')
    cpSync(realMigrations, old, { recursive: true })
    const jp = join(old, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(jp, 'utf8')) as { entries: { tag: string }[] }
    journal.entries = journal.entries.filter((e) => e.tag <= '0007_plans_workers')
    mkdirSync(join(old, 'meta'), { recursive: true })
    writeFileSync(jp, JSON.stringify(journal))

    const dbPath = join(dir(), 'upgrade.db')
    const at7 = openDatabase({ dbPath, migrationsFolder: old })
    at7.sqlite
      .prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('old', 'Old', 'old', 1, 1)
    at7.sqlite
      .prepare(
        "INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,status,created_at,last_active_at) VALUES ('s-old','old','Old','plan_first',3,'haiku','active',1,1)"
      )
      .run()
    at7.sqlite.close()

    const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
    try {
      expect(new SessionsRepo(upgraded.db).getById('s-old')).toMatchObject({
        model: 'haiku',
        brainModel: 'sonnet'
      })
    } finally {
      upgraded.sqlite.close()
    }
  })
})
