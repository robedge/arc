import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { FileReadsRepo } from '../../../src/main/db/repositories/file-reads-repo'
import {
  UsageSuggestionsRepo,
  type UsageSuggestionInput
} from '../../../src/main/db/repositories/usage-suggestions-repo'
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

function seedSession(s: OpenedDatabase['sqlite'], id: string, name = 'Sess'): void {
  s.prepare(
    `INSERT OR IGNORE INTO groups (id,name,name_key,created_at,updated_at) VALUES ('g1','G','g',1,1)`
  ).run()
  s.prepare(
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
     VALUES (?,'g1',?,'autonomous',2,'opus','sonnet','active',1,50)`
  ).run(id, name)
}

describe('migration 0027_usage_suggestions', () => {
  it('adds both tables on a populated 0026 database and cascades on session delete', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({
      dbPath,
      migrationsFolder: migrationsUpTo('0026_plan_limits', join(dir(), 'm-0026'))
    })
    seedSession(old.sqlite, 's1')
    old.sqlite.close()

    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 })
    const suggest = (id: string, key: string, kind = 'long_running'): void => {
      s.prepare(
        `INSERT INTO usage_suggestions (id,kind,session_id,dedupe_key,text,advice,params_json,usage_day,created_at)
         VALUES (?,?,'s1',?,'t','a','{}','2026-01-01',1)`
      ).run(id, kind, key)
    }
    suggest('a', 'k1')
    expect(() => suggest('b', 'k1')).toThrow()
    expect(() => suggest('c', 'k2', 'bogus')).toThrow()
    s.prepare(
      `INSERT INTO session_file_reads (session_id,agent_key,path,read_count,last_read_at)
       VALUES ('s1','brain','a.ts',1,1)`
    ).run()
    s.prepare('DELETE FROM sessions WHERE id = ?').run('s1')
    expect(s.prepare('SELECT count(*) AS n FROM usage_suggestions').get()).toEqual({ n: 0 })
    expect(s.prepare('SELECT count(*) AS n FROM session_file_reads').get()).toEqual({ n: 0 })
    s.close()
  })
})

describe('migration 0028_reset_setup_overhead', () => {
  it('removes open setup-overhead suggestions of the old rules and keeps dismissed ones and other kinds', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({
      dbPath,
      migrationsFolder: migrationsUpTo('0027_usage_suggestions', join(dir(), 'm-0027'))
    })
    seedSession(old.sqlite, 's1')
    const put = (id: string, kind: string, key: string, dismissedAt: number | null): void => {
      old.sqlite
        .prepare(
          `INSERT INTO usage_suggestions (id,kind,session_id,dedupe_key,text,advice,params_json,usage_day,created_at,dismissed_at)
           VALUES (?,?,'s1',?,'t','a','{}','2026-01-01',1,?)`
        )
        .run(id, kind, key, dismissedAt)
    }
    put('agent', 'setup_overhead', 'setup-overhead|s1|w1', null)
    put('session', 'setup_overhead', 'setup-overhead|s1', null)
    put('dismissed', 'setup_overhead', 'setup-overhead|s1|brain', 5)
    put('other', 'long_running', 'long-running|s1|w1', null)
    old.sqlite.close()

    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const ids = opened.sqlite
      .prepare('SELECT id FROM usage_suggestions ORDER BY id')
      .all()
      .map((r) => (r as { id: string }).id)
    opened.sqlite.close()
    expect(ids).toEqual(['dismissed', 'other'])
  })
})

const sug = (over: Partial<UsageSuggestionInput> = {}): UsageSuggestionInput => ({
  id: 'u1',
  kind: 'repeated_work',
  sessionId: 's1',
  agentKey: 'w1',
  workerId: 'w1',
  dedupeKey: 'repeated|s1|a.ts',
  text: 'read 3 times',
  advice: 'note it',
  params: { count: 3 },
  usageDay: '2026-03-10',
  createdAt: 100,
  ...over
})

describe('repos', () => {
  let opened: OpenedDatabase
  beforeEach(() => {
    opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
    seedSession(opened.sqlite, 's1', 'First')
    seedSession(opened.sqlite, 's2', 'Second')
  })
  afterEach(() => opened.sqlite.close())

  describe('UsageSuggestionsRepo', () => {
    it('refreshes text, advice and params of an open suggestion with the same dedupe key', () => {
      const repo = new UsageSuggestionsRepo(opened.db)
      repo.upsert(sug())
      repo.upsert(sug({ id: 'u2', text: 'read 5 times', advice: 'b', params: { count: 5 } }))
      const list = repo.forSession('s1')
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({
        id: 'u1',
        kind: 'repeated-work',
        sessionName: 'First',
        agentKey: 'w1',
        workerId: 'w1',
        text: 'read 5 times',
        advice: 'b',
        params: { count: 5 },
        createdAt: 100
      })
    })

    it('never recreates or changes a dismissed suggestion, and does not return it', () => {
      const repo = new UsageSuggestionsRepo(opened.db)
      repo.upsert(sug())
      repo.dismiss('u1', 200)
      repo.upsert(sug({ id: 'u2', text: 'read 9 times', params: { count: 9 } }))
      expect(repo.forSession('s1')).toEqual([])
      expect(repo.listForRange('all', new Date(2026, 2, 10, 12).getTime())).toEqual([])
      const row = opened.sqlite.prepare('SELECT id,text,dismissed_at FROM usage_suggestions').all()
      expect(row).toEqual([{ id: 'u1', text: 'read 3 times', dismissed_at: 200 }])
    })

    it('omits agent and worker when null and orders newest first', () => {
      const repo = new UsageSuggestionsRepo(opened.db)
      repo.upsert(sug({ id: 'old', dedupeKey: 'a', createdAt: 1, agentKey: null, workerId: null }))
      repo.upsert(sug({ id: 'new', dedupeKey: 'b', createdAt: 2 }))
      const list = repo.forSession('s1')
      expect(list.map((x) => x.id)).toEqual(['new', 'old'])
      expect(list[1]).not.toHaveProperty('agentKey')
      expect(list[1]).not.toHaveProperty('workerId')
    })

    it('lists by local usage day with inclusive range boundaries', () => {
      const repo = new UsageSuggestionsRepo(opened.db)
      const now = new Date(2026, 2, 10, 12).getTime()
      const days = [
        '2026-03-03',
        '2026-03-04',
        '2026-03-10',
        '2026-03-11',
        '2026-02-09',
        '2026-02-08'
      ]
      days.forEach((usageDay, i) =>
        repo.upsert(sug({ id: `d${i}`, dedupeKey: `k${i}`, usageDay, createdAt: i + 1 }))
      )
      const ids = (r: 'today' | '7d' | '30d' | 'all'): string[] =>
        repo
          .listForRange(r, now)
          .map((x) => x.id)
          .sort()
      expect(ids('today')).toEqual(['d2'])
      expect(ids('7d')).toEqual(['d1', 'd2'])
      expect(ids('30d')).toEqual(['d0', 'd1', 'd2', 'd4'])
      expect(ids('all')).toEqual(['d0', 'd1', 'd2', 'd4', 'd5'])
      expect(repo.listForRange('all', now)[0]?.id).toBe('d5')
    })
  })

  describe('FileReadsRepo', () => {
    it('counts reads across two agents and reports files reaching the minimum', () => {
      const repo = new FileReadsRepo(opened.db)
      repo.bump('s1', 'brain', 'src/a.ts', 1)
      repo.bump('s1', 'brain', 'src/a.ts', 2)
      expect(repo.repeated('s1', 3)).toEqual([])
      repo.bump('s1', 'w1', 'src/a.ts', 3)
      repo.bump('s1', 'w1', 'src/b.ts', 3)
      repo.bump('s2', 'w1', 'src/a.ts', 3)
      expect(repo.repeated('s1', 3)).toEqual([
        { path: 'src/a.ts', count: 3, agentKeys: ['brain', 'w1'] }
      ])
      expect(repo.repeated('s1', 2)).toHaveLength(1)
      expect(repo.repeated('s1', 1)).toHaveLength(2)
    })
  })
})
