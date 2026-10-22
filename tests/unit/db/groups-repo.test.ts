import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { ulid } from '../../../src/main/db/ids'
import { GroupsRepo, isUniqueViolation } from '../../../src/main/db/repositories/groups-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: GroupsRepo

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  repo = new GroupsRepo(opened.db)
})
afterEach(() => opened.sqlite.close())

function row(name: string, nameKey: string, sortOrder = 0, createdAt = 1000) {
  return { id: ulid(), name, nameKey, sortOrder, createdAt, updatedAt: createdAt }
}

describe('GroupsRepo', () => {
  it('round-trips insert, getById and getByNameKey', () => {
    const g = row('Storefront', 'storefront')
    repo.insert(g)
    expect(repo.getById(g.id)).toEqual(g)
    expect(repo.getByNameKey('storefront')).toEqual(g)
    expect(repo.getById('missing')).toBeUndefined()
    expect(repo.getByNameKey('missing')).toBeUndefined()
  })

  it('lists ordered by sort_order then created_at', () => {
    const c = row('C', 'c', 1, 1)
    const b = row('B', 'b', 0, 20)
    const a = row('A', 'a', 0, 10)
    repo.insert(c)
    repo.insert(b)
    repo.insert(a)
    expect(repo.list().map((g) => g.name)).toEqual(['A', 'B', 'C'])
  })

  it('rejects a duplicate name_key and isUniqueViolation detects it', () => {
    repo.insert(row('Storefront', 'storefront'))
    let caught: unknown
    try {
      repo.insert(row('STOREFRONT', 'storefront'))
    } catch (err: unknown) {
      caught = err
    }
    expect(caught).toBeDefined()
    expect(isUniqueViolation(caught)).toBe(true)
    expect(isUniqueViolation(new Error('other'))).toBe(false)
    expect(repo.list()).toHaveLength(1)
  })
})
