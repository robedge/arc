import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()

/** A migrations folder holding the real migrations up to and including `lastTag`. */
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

function seed0023(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0023_codex_provider', join(dir(), 'm-0023'))
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
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,model,brain_model,status,created_at,last_active_at)
     VALUES ('s1','g1','a','autonomous',2,'opus','sonnet','active',1,50)`
  ).run()
  s.prepare(
    `INSERT INTO workers (id,session_id,number,slug,task,project_ids_json,model,status,created_at,updated_at)
     VALUES ('w1','s1',1,'api','t','[]','opus','done',1,1)`
  ).run()
  s.prepare("INSERT INTO app_settings (key,value_json,updated_at) VALUES ('x','1',1)").run()
  old.sqlite.close()
}

describe('migration 0024_usage_turns', () => {
  it('adds usage_turns and the tracking setting without touching existing rows', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0023(dbPath)
    const before = Date.now()
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()

    const db = new Database(dbPath, { readonly: true })
    const count = (t: string): number =>
      (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
    expect([count('groups'), count('sessions'), count('workers')]).toEqual([1, 1, 1])
    expect(db.prepare("SELECT value_json FROM app_settings WHERE key = 'x'").get()).toEqual({
      value_json: '1'
    })
    expect(count('usage_turns')).toBe(0)

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'usage_turns'")
        .all() as {
        name: string
      }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'usage_turns_day_idx',
        'usage_turns_session_agent_idx',
        'usage_turns_provider_model_day_idx',
        'usage_turns_turn_key_uq'
      ])
    )

    const setting = db
      .prepare(
        "SELECT value_json, updated_at FROM app_settings WHERE key = 'usage.trackingStartedAt'"
      )
      .all() as { value_json: string; updated_at: number }[]
    expect(setting).toHaveLength(1)
    const startedAt = JSON.parse(setting[0]!.value_json) as number
    expect(startedAt).toBeGreaterThan(before - 5000)
    expect(startedAt).toBeLessThan(Date.now() + 5000)
    expect(setting[0]!.updated_at).toBe(startedAt)
    db.close()
  })

  it('inserts the tracking setting once and keeps it across reopen', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0023(dbPath)
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()
    const first = new Database(dbPath, { readonly: true })
    const v1 = first
      .prepare("SELECT value_json FROM app_settings WHERE key = 'usage.trackingStartedAt'")
      .get()
    first.close()
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()
    const db = new Database(dbPath, { readonly: true })
    expect(
      db
        .prepare("SELECT count(*) AS n FROM app_settings WHERE key = 'usage.trackingStartedAt'")
        .get()
    ).toEqual({ n: 1 })
    expect(
      db.prepare("SELECT value_json FROM app_settings WHERE key = 'usage.trackingStartedAt'").get()
    ).toEqual(v1)
    db.close()
  })

  it('does not constrain provider and rejects bad roles and negative counts', () => {
    const opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
    const insert = (role: string, provider: string, input: number): void => {
      opened.sqlite
        .prepare(
          `INSERT INTO usage_turns (agent_key,agent_role,provider,model,at,day,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens)
           VALUES ('k',?,?,'m',1,'2026-01-01',?,0,0,0)`
        )
        .run(role, provider, input)
    }
    expect(() => insert('brain', 'cursor', 1)).not.toThrow()
    expect(() => insert('nope', 'claude', 1)).toThrow()
    expect(() => insert('brain', 'claude', -1)).toThrow()
    opened.sqlite.close()
  })
})
