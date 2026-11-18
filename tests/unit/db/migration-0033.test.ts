import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import { messageRowDto } from '../../../src/main/sessions/message-prompt'
import { MessagesRepo } from '../../../src/main/db/repositories/messages-repo'
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

function seed0032(dbPath: string): void {
  const old = openDatabase({
    dbPath,
    migrationsFolder: migrationsUpTo('0032_skip_approvals', join(dir(), 'm-0032'))
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
    `INSERT INTO sessions (id,group_id,name,mode,worker_limit,status,created_at,last_active_at)
     VALUES ('s1','g1','a','autonomous',2,'active',1,50)`
  ).run()
  s.prepare(
    `INSERT INTO messages (session_id,role,content,state,created_at,updated_at)
     VALUES ('s1','user','hi','complete',1,1)`
  ).run()
  s.close()
}

describe('migration 0033_message_spoken', () => {
  it('reads 0 for a message that existed before, and the column is NOT NULL', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0032(dbPath)
    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const s = opened.sqlite
    expect(s.prepare('SELECT spoken FROM messages').get()).toEqual({ spoken: 0 })
    const col = (
      s.prepare('PRAGMA table_info(messages)').all() as { name: string; notnull: number }[]
    ).find((c) => c.name === 'spoken')
    expect(col?.notnull).toBe(1)
    expect(() => s.prepare('UPDATE messages SET spoken = NULL').run()).toThrow()
    s.close()
  })

  it('round-trips spoken through the repository', () => {
    const dbPath = join(dir(), 'arc.db')
    seed0032(dbPath)
    const opened = openDatabase({ dbPath, migrationsFolder: realMigrations })
    const repo = new MessagesRepo(opened.db)
    const base = {
      sessionId: 's1',
      role: 'user',
      content: 'x',
      state: 'complete',
      planId: null,
      createdAt: 2,
      updatedAt: 2
    } as const
    expect(repo.append(base).spoken).toBe(false)
    const spoken = repo.append({ ...base, spoken: true })
    expect(spoken.spoken).toBe(true)
    expect(messageRowDto(spoken).spoken).toBe(true)
    expect(messageRowDto(repo.append(base))).not.toHaveProperty('spoken')
    opened.sqlite.close()
  })
})
