import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import { useTempDir } from '../helpers/temp-dir'
import { makeMigrationsWithExtra, realMigrations } from './helpers'

const dir = useTempDir()

/** Tag of the newest real migration; the backup is named after the last applied one. */
function latestTag(): string {
  const journal = JSON.parse(
    readFileSync(join(realMigrations, 'meta', '_journal.json'), 'utf8')
  ) as {
    entries: { tag: string }[]
  }
  return journal.entries[journal.entries.length - 1]!.tag
}

function backups(): string[] {
  return readdirSync(dir()).filter((f) => f.startsWith('arc.db.bak-'))
}

describe('openDatabase', () => {
  it('applies migrations to a fresh db and creates the groups table', () => {
    const { sqlite } = openDatabase({
      dbPath: join(dir(), 'arc.db'),
      migrationsFolder: realMigrations
    })
    const cols = sqlite.prepare("PRAGMA table_info('groups')").all() as {
      name: string
      type: string
      notnull: number
      pk: number
    }[]
    expect(cols.map((c) => c.name)).toEqual([
      'id',
      'name',
      'name_key',
      'sort_order',
      'created_at',
      'updated_at'
    ])
    expect(cols.find((c) => c.name === 'id')?.pk).toBe(1)
    expect(cols.every((c) => c.notnull === 1)).toBe(true)
    sqlite.close()
  })

  it('sets WAL, foreign_keys and busy_timeout', () => {
    const { sqlite } = openDatabase({
      dbPath: join(dir(), 'arc.db'),
      migrationsFolder: realMigrations
    })
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal')
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1)
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000)
    sqlite.close()
  })

  it('makes no backup for a brand-new db', () => {
    const first = openDatabase({
      dbPath: join(dir(), 'arc.db'),
      migrationsFolder: makeMigrationsWithExtra(join(dir(), 'm-new'))
    })
    expect(first.backupPath).toBeNull()
    first.sqlite.close()
    expect(backups()).toEqual([])
  })

  it('makes no backup when nothing is pending', () => {
    const dbPath = join(dir(), 'arc.db')
    openDatabase({ dbPath, migrationsFolder: realMigrations }).sqlite.close()
    const again = openDatabase({ dbPath, migrationsFolder: realMigrations })
    expect(again.backupPath).toBeNull()
    again.sqlite.close()
    expect(backups()).toEqual([])
  })

  it('backs up an existing db before applying a pending migration', () => {
    const dbPath = join(dir(), 'arc.db')
    const old = openDatabase({ dbPath, migrationsFolder: realMigrations })
    old.sqlite
      .prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('g1', 'Old', 'old', 1, 1)
    old.sqlite.close()

    const upgraded = openDatabase({
      dbPath,
      migrationsFolder: makeMigrationsWithExtra(join(dir(), 'm-up'))
    })
    const backupName = `arc.db.bak-${latestTag()}`
    expect(backups()).toEqual([backupName])
    expect(upgraded.backupPath).toBe(join(dir(), backupName))
    expect(
      upgraded.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='test_extra'").get()
    ).toBeTruthy()
    upgraded.sqlite.close()
    expect(existsSync(join(dir(), backupName))).toBe(true)
  })
})
