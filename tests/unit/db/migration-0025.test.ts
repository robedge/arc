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

function seed0024(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0024_usage_turns', join(dir(), 'm-0024'))
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
  old.sqlite.close()
}

describe('migration 0025_agent_setup', () => {
  it('adds agent_setup on a populated 0024 database and cascades with the session', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0024(dbPath)
    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT count(*) AS n FROM usage_turns').get()).toEqual({ n: 1 })
    const insert = (key: string, provider: string): void => {
      s.prepare(
        `INSERT INTO agent_setup (session_id,agent_key,provider,arc_additions_tokens,estimated_at)
         VALUES ('s1',?,?,100,1)`
      ).run(key, provider)
    }
    insert('brain', 'claude')
    insert('brain', 'codex')
    expect(() => insert('brain', 'claude')).toThrow()
    expect(() =>
      s
        .prepare(
          "INSERT INTO agent_setup (session_id,agent_key,provider,arc_additions_tokens,estimated_at) VALUES ('nope','b','claude',1,1)"
        )
        .run()
    ).toThrow()
    expect(s.prepare('SELECT fixed_setup_tokens, model FROM agent_setup LIMIT 1').get()).toEqual({
      fixed_setup_tokens: null,
      model: null
    })
    s.prepare("DELETE FROM sessions WHERE id = 's1'").run()
    expect(s.prepare('SELECT count(*) AS n FROM agent_setup').get()).toEqual({ n: 0 })
    s.close()
  })
})
