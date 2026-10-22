import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>
/** A database handle or an open transaction on it; repositories accept either. */
export type DbHandle = Db | Parameters<Parameters<Db['transaction']>[0]>[0]

export interface OpenDatabaseOptions {
  dbPath: string
  migrationsFolder: string
}

export interface OpenedDatabase {
  db: Db
  /** The raw handle, for closing and pragmas. */
  sqlite: Database.Database
  /** Path of the pre-migration backup, when one was made. */
  backupPath: string | null
}

interface JournalEntry {
  tag: string
  when: number
}

/** Thrown when a migration fails; carries the backup path (if any) for the startup dialog. */
export class MigrationError extends Error {
  readonly backupPath: string | null
  constructor(cause: unknown, backupPath: string | null) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'MigrationError'
    this.backupPath = backupPath
  }
}

export function resolveMigrationsFolder(opts: {
  isPackaged: boolean
  resourcesPath: string
  appRoot: string
}): string {
  return opts.isPackaged
    ? join(opts.resourcesPath, 'migrations')
    : join(opts.appRoot, 'src', 'main', 'db', 'migrations')
}

function readJournal(migrationsFolder: string): JournalEntry[] {
  const raw = readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] }
  return parsed.entries
}

/** Returns the `created_at` values of applied migrations, or [] when the table does not exist. */
function appliedTimestamps(sqlite: Database.Database): number[] {
  const table = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .get()
  if (!table) return []
  const rows = sqlite.prepare('SELECT created_at FROM __drizzle_migrations').all() as {
    created_at: number
  }[]
  return rows.map((r) => Number(r.created_at))
}

export function openDatabase(opts: OpenDatabaseOptions): OpenedDatabase {
  const sqlite = new Database(opts.dbPath)
  let backupPath: string | null = null
  try {
    sqlite.pragma('journal_mode = WAL')
    sqlite.pragma('foreign_keys = ON')
    sqlite.pragma('busy_timeout = 5000')

    const journal = readJournal(opts.migrationsFolder)
    const applied = appliedTimestamps(sqlite)
    const lastApplied = applied.length > 0 ? Math.max(...applied) : null
    const hasPending = journal.some((e) => lastApplied === null || e.when > lastApplied)

    if (hasPending && lastApplied !== null) {
      const latest = journal.find((e) => e.when === lastApplied)
      const label = latest ? latest.tag : String(applied.length)
      backupPath = `${opts.dbPath}.bak-${label}`
      // Fold the WAL into the main file so the copy is complete.
      sqlite.pragma('wal_checkpoint(TRUNCATE)')
      copyFileSync(opts.dbPath, backupPath)
    }

    const db = drizzle(sqlite, { schema })
    try {
      migrate(db, { migrationsFolder: opts.migrationsFolder })
    } catch (err: unknown) {
      throw new MigrationError(err, backupPath)
    }
    return { db, sqlite, backupPath }
  } catch (err: unknown) {
    sqlite.close()
    throw err
  }
}
