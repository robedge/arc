import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()

interface JournalEntry {
  tag: string
}

/** A migrations folder holding the real migrations up to and including `lastTag`. */
function migrationsUpTo(lastTag: string, dest: string): string {
  cpSync(realMigrations, dest, { recursive: true })
  const journalPath = join(dest, 'meta', '_journal.json')
  mkdirSync(join(dest, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[]
  }
  const cut = journal.entries.findIndex((e) => e.tag === lastTag)
  journal.entries = journal.entries.slice(0, cut + 1)
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dest
}

/** A database migrated to 0022 holding sessions, workers, worktrees and held messages. */
function seed0022(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0022_worker_user_control', join(dir(), 'm-0022'))
  })
  const s = old.sqlite
  s.prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    'g1',
    'G',
    'g',
    1,
    1
  )
  s.prepare(
    "INSERT INTO projects (id,path,display_name,created_at) VALUES ('p1','/tmp/p','p',1)"
  ).run()
  const insertSession = s.prepare(
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,brain_claude_session_id,created_at,last_active_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  insertSession.run(
    's-opus',
    'g1',
    'a',
    'autonomous',
    2,
    'opus',
    'sonnet',
    'active',
    'brain-1',
    1,
    50
  )
  insertSession.run('s-auto', 'g1', 'b', 'autonomous', 2, 'auto', 'sonnet', 'active', null, 1, 60)
  insertSession.run(
    's-full',
    'g1',
    'c',
    'autonomous',
    2,
    'claude-opus-4-5',
    'sonnet',
    'active',
    'brain-3',
    1,
    70
  )
  s.prepare(
    `INSERT INTO workers (id,session_id,number,slug,task,project_ids_json,model,status,claude_session_id,created_at,updated_at)
     VALUES ('w1','s-opus',1,'api','t','[]','opus','done','worker-sess-1',1,1)`
  ).run()
  s.prepare(
    `INSERT INTO worker_worktrees (worker_id,project_id,path,base_sha,head_sha) VALUES ('w1','p1','/tmp/wt','a','b')`
  ).run()
  s.prepare(
    `INSERT INTO worker_held_messages (worker_id,session_id,body,created_at) VALUES ('w1','s-opus','hold on',5)`
  ).run()
  old.sqlite.close()
}

function readAll(dbPath: string): Database.Database {
  return new Database(dbPath, { readonly: true })
}

describe('migration 0023_codex_provider', () => {
  it('upgrades a 0022 database keeping ids, worktrees and held messages, and backs it up', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0022(dbPath)

    const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
    upgraded.sqlite.close()
    expect(existsSync(join(dir(), 'arc.db.bak-0022_worker_user_control'))).toBe(true)

    const db = readAll(dbPath)
    const worker = db.prepare('SELECT * FROM workers WHERE id = ?').get('w1') as Record<
      string,
      unknown
    >
    expect(worker).toMatchObject({
      provider_session_id: 'worker-sess-1',
      provider: 'claude',
      requested_provider: null,
      fallback_reason: null
    })
    expect('claude_session_id' in worker).toBe(false)
    expect(db.prepare('SELECT count(*) AS n FROM worker_worktrees').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT body FROM worker_held_messages').get()).toEqual({ body: 'hold on' })
    expect(db.prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 3 })
    db.close()
  })

  it('backfills workers_pref_json from model', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0022(dbPath)
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()

    const db = readAll(dbPath)
    const pref = (id: string): unknown =>
      JSON.parse(
        (
          db.prepare('SELECT workers_pref_json AS p FROM sessions WHERE id = ?').get(id) as {
            p: string
          }
        ).p
      )
    expect(pref('s-auto')).toEqual({ mode: 'auto' })
    expect(pref('s-opus')).toEqual({ mode: 'model', model: { provider: 'claude', model: 'opus' } })
    expect(pref('s-full')).toEqual({
      mode: 'model',
      model: { provider: 'claude', model: 'claude-opus-4-5' }
    })
    expect(db.prepare('SELECT DISTINCT brain_provider AS b FROM sessions').all()).toEqual([
      { b: 'claude' }
    ])
    db.close()
  })

  it('backfills brain_threads from brain_claude_session_id and leaves the old column', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0022(dbPath)
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()

    const db = readAll(dbPath)
    expect(
      db
        .prepare('SELECT session_id, provider, thread_id FROM brain_threads ORDER BY session_id')
        .all()
    ).toEqual([
      { session_id: 's-full', provider: 'claude', thread_id: 'brain-3' },
      { session_id: 's-opus', provider: 'claude', thread_id: 'brain-1' }
    ])
    expect(
      db.prepare('SELECT brain_claude_session_id AS b FROM sessions WHERE id = ?').get('s-opus')
    ).toEqual({ b: 'brain-1' })
    db.close()
  })
})
