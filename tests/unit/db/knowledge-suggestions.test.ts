import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import {
  KnowledgeSuggestionsRepo,
  type KnowledgeSuggestionInput
} from '../../../src/main/db/repositories/knowledge-suggestions-repo'
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

const sug = (over: Partial<KnowledgeSuggestionInput> = {}): KnowledgeSuggestionInput => ({
  id: 'k1',
  sessionId: 's1',
  groupId: 'g1',
  requestId: 'm1',
  action: 'new',
  title: 'Orders are partitioned',
  reason: 'Read in the schema',
  sectionId: 'sec1',
  sectionName: 'Notes',
  proposedName: 'Orders.md',
  proposedContent: 'partitioned by month',
  dedupeKey: 'key-1',
  createdAt: 100,
  ...over
})

const rawInsert = (s: OpenedDatabase['sqlite'], over: Record<string, unknown> = {}): void => {
  const row: Record<string, unknown> = {
    id: 'r1',
    session_id: 's1',
    group_id: 'g1',
    request_id: 'm1',
    action: 'new',
    title: 't',
    reason: 'r',
    section_id: 'sec',
    section_name: 'Notes',
    proposed_name: 'n.md',
    proposed_content: 'c',
    dedupe_key: 'dk',
    status: 'waiting',
    created_at: 1,
    resolved_at: null,
    ...over
  }
  const cols = Object.keys(row)
  s.prepare(
    `INSERT INTO knowledge_suggestions (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...Object.values(row))
}

describe('migration 0029_knowledge_suggestions', () => {
  it('adds the table on a populated 0028 database and cascades on session delete', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({
      dbPath,
      migrationsFolder: migrationsUpTo('0028_reset_setup_overhead', join(dir(), 'm-0028'))
    })
    seedSession(old.sqlite, 's1')
    old.sqlite
      .prepare(
        `INSERT INTO usage_suggestions (id,kind,session_id,dedupe_key,text,advice,params_json,usage_day,created_at)
         VALUES ('u1','long_running','s1','k','t','a','{}','2026-01-01',1)`
      )
      .run()
    old.sqlite.close()

    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT count(*) AS n FROM usage_suggestions').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT count(*) AS n FROM knowledge_suggestions').get()).toEqual({ n: 0 })
    const repo = new KnowledgeSuggestionsRepo(opened.db)
    expect(repo.insert(sug())).toMatchObject({ inserted: true })
    s.close()
  })
})

describe('KnowledgeSuggestionsRepo', () => {
  let opened: OpenedDatabase
  let repo: KnowledgeSuggestionsRepo
  beforeEach(() => {
    opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
    seedSession(opened.sqlite, 's1')
    seedSession(opened.sqlite, 's2')
    repo = new KnowledgeSuggestionsRepo(opened.db)
  })
  afterEach(() => opened.sqlite.close())

  describe('CHECK constraints', () => {
    it('accepts a valid raw row', () => {
      expect(() => rawInsert(opened.sqlite)).not.toThrow()
    })
    it('rejects an unknown action', () => {
      expect(() => rawInsert(opened.sqlite, { action: 'delete' })).toThrow(/CHECK/)
    })
    it('rejects an unknown status', () => {
      expect(() => rawInsert(opened.sqlite, { status: 'bogus' })).toThrow(/CHECK/)
    })
    it('rejects a waiting row that has resolved_at', () => {
      expect(() => rawInsert(opened.sqlite, { status: 'waiting', resolved_at: 5 })).toThrow(/CHECK/)
    })
    it('rejects a resolved row without resolved_at', () => {
      expect(() => rawInsert(opened.sqlite, { status: 'discarded', resolved_at: null })).toThrow(
        /CHECK/
      )
    })
    it('rejects a new row without a name and an update row without a target', () => {
      expect(() => rawInsert(opened.sqlite, { action: 'new', proposed_name: null })).toThrow(
        /CHECK/
      )
      expect(() =>
        rawInsert(opened.sqlite, { action: 'update', proposed_name: null, target_rel_path: null })
      ).toThrow(/CHECK/)
      expect(() =>
        rawInsert(opened.sqlite, { action: 'update', proposed_name: null, target_rel_path: 'a.md' })
      ).not.toThrow()
    })
    it('rejects a duplicate dedupe_key', () => {
      rawInsert(opened.sqlite)
      expect(() => rawInsert(opened.sqlite, { id: 'r2' })).toThrow(/UNIQUE/)
    })
  })

  describe('insert', () => {
    it('stores a new row as waiting with nullable update fields empty', () => {
      const res = repo.insert(sug())
      expect(res.inserted).toBe(true)
      if (!res.inserted) return
      expect(res.row).toMatchObject({
        id: 'k1',
        status: 'waiting',
        action: 'new',
        proposedName: 'Orders.md',
        targetRelPath: null,
        hunksJson: null,
        baseRevision: null,
        editedContent: null,
        resolvedAt: null,
        createdAt: 100
      })
    })

    it('stores update fields', () => {
      const res = repo.insert(
        sug({
          action: 'update',
          proposedName: null,
          targetRelPath: 'schema.md',
          hunksJson: '[]',
          baseRevision: 'rev1'
        })
      )
      expect(res.inserted && res.row).toMatchObject({
        action: 'update',
        targetRelPath: 'schema.md',
        hunksJson: '[]',
        baseRevision: 'rev1'
      })
    })

    it('reports the existing id and status for a repeated dedupe key, including a discarded one', () => {
      repo.insert(sug())
      expect(repo.insert(sug({ id: 'k2' }))).toEqual({
        inserted: false,
        existing: { id: 'k1', status: 'waiting' }
      })
      expect(repo.setOutcome('k1', 'discarded', 200)).toBe(true)
      expect(repo.insert(sug({ id: 'k3' }))).toEqual({
        inserted: false,
        existing: { id: 'k1', status: 'discarded' }
      })
      expect(repo.listWaiting('s1')).toEqual([])
    })
  })

  describe('setOutcome', () => {
    it('resolves a waiting row once and refuses a second resolution', () => {
      repo.insert(sug())
      expect(repo.setOutcome('k1', 'accepted', 200)).toBe(true)
      expect(repo.setOutcome('k1', 'discarded', 300)).toBe(false)
      expect(repo.get('k1')).toMatchObject({ status: 'accepted', resolvedAt: 200 })
    })

    it('stores the edited content', () => {
      repo.insert(sug())
      expect(repo.setOutcome('k1', 'accepted_edited', 200, 'my text')).toBe(true)
      expect(repo.get('k1')).toMatchObject({
        status: 'accepted_edited',
        editedContent: 'my text',
        resolvedAt: 200
      })
    })

    it('returns false for an unknown id', () => {
      expect(repo.setOutcome('nope', 'discarded', 1)).toBe(false)
    })
  })

  describe('get and listWaiting', () => {
    it('gets a row or undefined', () => {
      repo.insert(sug())
      expect(repo.get('k1')?.title).toBe('Orders are partitioned')
      expect(repo.get('nope')).toBeUndefined()
    })

    it('lists only waiting rows of the session, newest first', () => {
      repo.insert(sug({ id: 'old', dedupeKey: 'a', createdAt: 1 }))
      repo.insert(sug({ id: 'new', dedupeKey: 'b', createdAt: 3 }))
      repo.insert(sug({ id: 'mid', dedupeKey: 'c', createdAt: 2 }))
      repo.insert(sug({ id: 'gone', dedupeKey: 'd', createdAt: 4 }))
      repo.insert(sug({ id: 'other', dedupeKey: 'e', createdAt: 5, sessionId: 's2' }))
      repo.setOutcome('gone', 'discarded', 9)
      expect(repo.listWaiting('s1').map((r) => r.id)).toEqual(['new', 'mid', 'old'])
    })
  })

  describe('countForRequest', () => {
    it('counts every status for the request in the session', () => {
      repo.insert(sug({ id: 'a', dedupeKey: 'a', requestId: 'm1' }))
      repo.insert(sug({ id: 'b', dedupeKey: 'b', requestId: 'm1' }))
      repo.insert(sug({ id: 'c', dedupeKey: 'c', requestId: 'm2' }))
      repo.insert(sug({ id: 'd', dedupeKey: 'd', requestId: 'm1', sessionId: 's2' }))
      repo.setOutcome('a', 'discarded', 5)
      expect(repo.countForRequest('s1', 'm1')).toBe(2)
      expect(repo.countForRequest('s1', 'm2')).toBe(1)
      expect(repo.countForRequest('s1', 'm9')).toBe(0)
    })
  })

  describe('discardAllWaiting', () => {
    it('discards waiting rows of the session only and returns their ids', () => {
      repo.insert(sug({ id: 'a', dedupeKey: 'a', createdAt: 1 }))
      repo.insert(sug({ id: 'b', dedupeKey: 'b', createdAt: 2 }))
      repo.insert(sug({ id: 'c', dedupeKey: 'c', createdAt: 3 }))
      repo.insert(sug({ id: 'o', dedupeKey: 'o', sessionId: 's2' }))
      repo.setOutcome('c', 'accepted', 4)
      expect(repo.discardAllWaiting('s1', 50).sort()).toEqual(['a', 'b'])
      expect(repo.get('a')).toMatchObject({ status: 'discarded', resolvedAt: 50 })
      expect(repo.get('c')).toMatchObject({ status: 'accepted', resolvedAt: 4 })
      expect(repo.listWaiting('s2')).toHaveLength(1)
      expect(repo.discardAllWaiting('s1', 60)).toEqual([])
    })
  })

  it('removes the rows when the session is deleted', () => {
    repo.insert(sug())
    repo.insert(sug({ id: 'k2', dedupeKey: 'x', sessionId: 's2' }))
    repo.setOutcome('k1', 'discarded', 5)
    opened.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(repo.get('k1')).toBeUndefined()
    expect(repo.get('k2')).toBeDefined()
  })

  it('keeps a row when its section or group is gone (no foreign keys to them)', () => {
    repo.insert(sug({ groupId: 'no-such-group', sectionId: 'no-such-section' }))
    expect(repo.listWaiting('s1')).toHaveLength(1)
  })
})
