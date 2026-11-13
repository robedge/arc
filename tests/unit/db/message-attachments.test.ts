import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { MessageAttachmentsRepo } from '../../../src/main/db/repositories/message-attachments-repo'
import type { NewMessageAttachmentRow } from '../../../src/main/db/schema'
import { IMPORT_MAX_BYTES } from '../../../src/shared/limits'
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

function seedMessage(s: OpenedDatabase['sqlite'], sessionId: string): number {
  const r = s
    .prepare(
      `INSERT INTO messages (session_id,role,content,state,created_at,updated_at)
       VALUES (?,'user','hi','complete',1,1)`
    )
    .run(sessionId)
  return Number(r.lastInsertRowid)
}

const att = (over: Partial<NewMessageAttachmentRow> = {}): NewMessageAttachmentRow => ({
  id: 'a1',
  messageId: 1,
  sessionId: 's1',
  position: 0,
  kind: 'text',
  mime: 'text/plain',
  sizeBytes: 10,
  name: 'log.txt',
  storedName: 'log.txt',
  createdAt: 100,
  ...over
})

const WORKER_SQL = `INSERT INTO workers (id,session_id,number,slug,task,project_ids_json,model,status,created_at,updated_at)
  VALUES ('w1','s1',1,'w','t','[]','sonnet','queued',1,1)`

describe('migration 0030_message_attachments', () => {
  it('adds the table and column on a populated 0029 database and keeps existing rows', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({
      dbPath,
      migrationsFolder: migrationsUpTo('0029_knowledge_suggestions', join(dir(), 'm-0029'))
    })
    seedSession(old.sqlite, 's1')
    const messageId = seedMessage(old.sqlite, 's1')
    old.sqlite.prepare(WORKER_SQL).run()
    old.sqlite.close()

    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT attachments_json AS a FROM workers').get()).toEqual({ a: null })
    expect(s.prepare('SELECT count(*) AS n FROM message_attachments').get()).toEqual({ n: 0 })
    new MessageAttachmentsRepo(opened.db).insertMany([att({ messageId })])
    expect(s.prepare('SELECT count(*) AS n FROM message_attachments').get()).toEqual({ n: 1 })
    s.close()
  })
})

describe('MessageAttachmentsRepo', () => {
  let opened: OpenedDatabase
  let repo: MessageAttachmentsRepo
  let m1: number
  let m2: number
  let m3: number
  beforeEach(() => {
    opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
    seedSession(opened.sqlite, 's1')
    seedSession(opened.sqlite, 's2')
    m1 = seedMessage(opened.sqlite, 's1')
    m2 = seedMessage(opened.sqlite, 's1')
    m3 = seedMessage(opened.sqlite, 's2')
    repo = new MessageAttachmentsRepo(opened.db)
  })
  afterEach(() => opened.sqlite.close())

  const count = (): number =>
    (opened.sqlite.prepare('SELECT count(*) AS n FROM message_attachments').get() as { n: number })
      .n

  it('round-trips a row through get', () => {
    repo.insertMany([att({ messageId: m1 })])
    expect(repo.get('a1')).toEqual(att({ messageId: m1 }))
    expect(repo.get('nope')).toBeUndefined()
  })

  it('inserts nothing for an empty list', () => {
    repo.insertMany([])
    expect(count()).toBe(0)
  })

  it('lists several messages in one call, each by position', () => {
    repo.insertMany([
      att({ id: 'b', messageId: m2, position: 1 }),
      att({ id: 'a', messageId: m2, position: 0 }),
      att({ id: 'c', messageId: m1, position: 0 }),
      att({ id: 'z', messageId: m3, sessionId: 's2', position: 0 })
    ])
    const map = repo.listForMessages([m2, m1])
    expect([...map.keys()].sort()).toEqual([m1, m2].sort())
    expect(map.get(m2)?.map((r) => r.id)).toEqual(['a', 'b'])
    expect(map.get(m1)?.map((r) => r.id)).toEqual(['c'])
    expect(map.has(m3)).toBe(false)
  })

  it('returns an empty map for no ids without querying', () => {
    expect(repo.listForMessages([]).size).toBe(0)
  })

  it('getMany keeps the order of ids and ignores other sessions and unknown ids', () => {
    repo.insertMany([
      att({ id: 'a', messageId: m1 }),
      att({ id: 'b', messageId: m2 }),
      att({ id: 'x', messageId: m3, sessionId: 's2' })
    ])
    expect(repo.getMany(['b', 'x', 'missing', 'a'], 's1').map((r) => r.id)).toEqual(['b', 'a'])
    expect(repo.getMany([], 's1')).toEqual([])
  })

  it('listForSession orders by message then position', () => {
    repo.insertMany([
      att({ id: 'a', messageId: m2, position: 0 }),
      att({ id: 'b', messageId: m1, position: 1 }),
      att({ id: 'c', messageId: m1, position: 0 }),
      att({ id: 'x', messageId: m3, sessionId: 's2' })
    ])
    expect(repo.listForSession('s1').map((r) => r.id)).toEqual(['c', 'b', 'a'])
  })

  describe('constraints', () => {
    it('rejects a duplicate (message, position)', () => {
      repo.insertMany([att({ id: 'a', messageId: m1 })])
      expect(() => repo.insertMany([att({ id: 'b', messageId: m1 })])).toThrow(/UNIQUE/)
      expect(() => repo.insertMany([att({ id: 'b', messageId: m2 })])).not.toThrow()
    })
    it('rejects an unknown kind', () => {
      expect(() =>
        repo.insertMany([att({ messageId: m1, kind: 'video' as unknown as 'text' })])
      ).toThrow(/CHECK/)
    })
    it.each([0, -1, IMPORT_MAX_BYTES + 1])('rejects size %i', (sizeBytes) => {
      expect(() => repo.insertMany([att({ messageId: m1, sizeBytes })])).toThrow(/CHECK/)
    })
    it.each([1, IMPORT_MAX_BYTES])('accepts size %i', (sizeBytes) => {
      expect(() => repo.insertMany([att({ messageId: m1, sizeBytes })])).not.toThrow()
    })
    it('rejects a missing message or session', () => {
      expect(() => repo.insertMany([att({ messageId: 9999 })])).toThrow(/FOREIGN/)
      expect(() => repo.insertMany([att({ messageId: m1, sessionId: 'nope' })])).toThrow(/FOREIGN/)
    })
  })

  describe('cascades', () => {
    it('removes attachments with their message only', () => {
      repo.insertMany([att({ id: 'a', messageId: m1 }), att({ id: 'b', messageId: m2 })])
      opened.sqlite.prepare('DELETE FROM messages WHERE id = ?').run(m1)
      expect(repo.listForSession('s1').map((r) => r.id)).toEqual(['b'])
    })
    it('removes attachments with their session', () => {
      repo.insertMany([
        att({ id: 'a', messageId: m1 }),
        att({ id: 'x', messageId: m3, sessionId: 's2' })
      ])
      opened.sqlite.prepare(`DELETE FROM sessions WHERE id = 's1'`).run()
      expect(count()).toBe(1)
      expect(repo.get('x')).toBeDefined()
    })
  })

  it('workers.attachments_json defaults to null and stores text', () => {
    opened.sqlite.prepare(WORKER_SQL).run()
    const read = (): unknown =>
      opened.sqlite.prepare(`SELECT attachments_json AS a FROM workers WHERE id='w1'`).get()
    expect(read()).toEqual({ a: null })
    opened.sqlite.prepare(`UPDATE workers SET attachments_json='[]' WHERE id='w1'`).run()
    expect(read()).toEqual({ a: '[]' })
  })
})
