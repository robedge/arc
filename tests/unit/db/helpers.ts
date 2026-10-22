import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const realMigrations = resolve('src/main/db/migrations')

/** Builds a migrations folder with the real migrations plus the test-only 9999_test_extra. */
export function makeMigrationsWithExtra(dest: string): string {
  cpSync(realMigrations, dest, { recursive: true })
  cpSync(resolve('tests/unit/db/fixtures/0001_test_extra.sql'), join(dest, '9999_test_extra.sql'))
  const journalPath = join(dest, 'meta', '_journal.json')
  mkdirSync(join(dest, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[]
  }
  const last = journal.entries[journal.entries.length - 1]
  journal.entries.push({
    idx: journal.entries.length,
    version: '6',
    when: (last?.when ?? 0) + 1000,
    tag: '9999_test_extra',
    breakpoints: true
  })
  writeFileSync(journalPath, JSON.stringify(journal, null, 2))
  return dest
}
