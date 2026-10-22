import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { realMigrations } from './helpers'

describe('provider columns', () => {
  it('have no CHECK constraint in any migration, so adding a provider needs no migration', () => {
    const sql = readdirSync(realMigrations)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join(realMigrations, f), 'utf8'))
      .join('\n')
    expect(sql).not.toMatch(/CHECK\s*\([^)]*provider/i)
    expect(sql).not.toMatch(/CHECK\s*\([^)]*'codex'/i)
  })
})
