import { asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { groups } from '../schema'
import type { GroupRow, NewGroupRow } from '../schema'

export type { GroupRow, NewGroupRow }

/** True when `err` is a SQLite UNIQUE or PRIMARY KEY constraint violation (better-sqlite3). */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
  )
}

export class GroupsRepo {
  constructor(private readonly db: DbHandle) {}

  list(): GroupRow[] {
    return this.db.select().from(groups).orderBy(asc(groups.sortOrder), asc(groups.createdAt)).all()
  }

  getById(id: string): GroupRow | undefined {
    return this.db.select().from(groups).where(eq(groups.id, id)).get()
  }

  getByNameKey(nameKey: string): GroupRow | undefined {
    return this.db.select().from(groups).where(eq(groups.nameKey, nameKey)).get()
  }

  /** Throws the raw SQLite error on a duplicate name_key; use `isUniqueViolation` to detect it. */
  insert(row: NewGroupRow): void {
    this.db.insert(groups).values(row).run()
  }

  /** Throws the raw SQLite error on a duplicate name_key; use `isUniqueViolation` to detect it. */
  update(id: string, fields: { name: string; nameKey: string; updatedAt: number }): void {
    this.db.update(groups).set(fields).where(eq(groups.id, id)).run()
  }

  /** Runs in a transaction so dependent rows (added by later tables) cascade atomically. */
  delete(id: string): void {
    this.db.transaction((tx) => {
      tx.delete(groups).where(eq(groups.id, id)).run()
    })
  }
}
