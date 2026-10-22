import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function seed0025(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0025_agent_setup', join(dir(), 'm-0025'))
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
    `INSERT INTO usage_turns (agent_key,agent_role,session_id,provider,model,at,day,input_tokens,cache_write_tokens,cache_read_tokens,output_tokens)
     VALUES ('brain','brain','s1','claude','sonnet',1,'2026-01-01',5,0,0,1)`
  ).run()
  s.prepare(
    `INSERT INTO agent_setup (session_id,agent_key,provider,arc_additions_tokens,estimated_at)
     VALUES ('s1','brain','claude',100,1)`
  ).run()
  old.sqlite.close()
}

describe('migration 0026_plan_limits', () => {
  it('adds plan_limits and plan_notices on a populated 0025 database', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0025(dbPath)
    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM usage_turns').get()).toEqual({ n: 1 })
    expect(s.prepare('SELECT count(*) AS n FROM agent_setup').get()).toEqual({ n: 1 })
    const limit = (provider: string, window: string, source = 'event'): void => {
      s.prepare(
        'INSERT INTO plan_limits (provider,"window",label,used_percent,observed_at,source) VALUES (?,?,?,?,?,?)'
      ).run(provider, window, '5h', 12.5, 1, source)
    }
    limit('claude', 'five_hour')
    limit('codex', 'five_hour')
    expect(() => limit('claude', 'five_hour')).toThrow()
    expect(() => limit('claude', 'weekly', 'bogus')).toThrow()
    expect(s.prepare('SELECT resets_at, plan_type FROM plan_limits LIMIT 1').get()).toEqual({
      resets_at: null,
      plan_type: null
    })
    const notice = (key: string, threshold: number): void => {
      s.prepare(
        'INSERT INTO plan_notices (key,provider,"window",threshold,notified_at) VALUES (?,?,?,?,1)'
      ).run(key, 'claude', 'five_hour', threshold)
    }
    notice('a', 80)
    expect(() => notice('a', 95)).toThrow()
    expect(() => notice('b', 50)).toThrow()
    s.close()
  })
})
