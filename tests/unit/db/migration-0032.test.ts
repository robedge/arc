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

function seed0031(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0031_branch_questions', join(dir(), 'm-0031'))
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
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,status,auto_approve,created_at,last_active_at)
     VALUES ('s1','g1','a','autonomous',2,'active',1,1,50)`
  ).run()
  s.close()
}

describe('migration 0032_skip_approvals', () => {
  it('reads 0 for a session that existed before, and the column is NOT NULL', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0031(dbPath)
    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(
      s.prepare("SELECT skip_approvals, auto_approve FROM sessions WHERE id='s1'").get()
    ).toEqual({
      skip_approvals: 0,
      auto_approve: 1
    })
    const col = (
      s.prepare('PRAGMA table_info(sessions)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'skip_approvals')
    expect(col?.notnull).toBe(1)
    expect(() =>
      s.prepare("UPDATE sessions SET skip_approvals = NULL WHERE id='s1'").run()
    ).toThrow()
    s.close()
  })
})
