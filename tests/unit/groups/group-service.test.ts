import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { GroupService, removeAppGroupDir } from '../../../src/main/groups/group-service'
import { AppErrorException } from '../../../src/shared/errors'
import type { ErrorCode } from '../../../src/shared/errors'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from '../db/helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: GroupsRepo
let service: GroupService
let userData: string

beforeEach(() => {
  userData = join(dir(), 'userData')
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  repo = new GroupsRepo(opened.db)
  service = new GroupService({ db: opened.db, groupsRepo: repo, appDataDir: userData })
})
afterEach(() => opened.sqlite.close())

async function codeOf(p: Promise<unknown>): Promise<ErrorCode | undefined> {
  try {
    await p
  } catch (error: unknown) {
    if (error instanceof AppErrorException) return error.code
    throw error
  }
  return undefined
}

describe('GroupService.create', () => {
  it('returns the DTO, stores the row and creates the knowledge folder', async () => {
    const group = await service.create('Storefront')
    expect(group).toEqual({
      id: expect.any(String),
      name: 'Storefront',
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number)
    })
    expect(repo.getById(group.id)?.name).toBe('Storefront')
    expect(existsSync(join(userData, 'groups', group.id, 'knowledge'))).toBe(true)
  })

  it('uses the injected clock and id', async () => {
    const s = new GroupService({
      db: opened.db,
      groupsRepo: repo,
      appDataDir: userData,
      now: () => 42,
      newId: () => 'fixed-id'
    })
    expect(await s.create('A')).toEqual({ id: 'fixed-id', name: 'A', createdAt: 42, updatedAt: 42 })
  })

  it('rejects empty and whitespace-only names', async () => {
    expect(await codeOf(service.create(''))).toBe('GROUP_NAME_REQUIRED')
    expect(await codeOf(service.create('   '))).toBe('GROUP_NAME_REQUIRED')
  })

  it('accepts 60 characters and rejects 61', async () => {
    expect(await codeOf(service.create('a'.repeat(60)))).toBeUndefined()
    expect(await codeOf(service.create('b'.repeat(61)))).toBe('GROUP_NAME_TOO_LONG')
  })

  it('rejects duplicates case-insensitively and after trimming', async () => {
    await service.create('Storefront')
    expect(await codeOf(service.create('storefront'))).toBe('GROUP_NAME_DUPLICATE')
    expect(await codeOf(service.create('  Storefront '))).toBe('GROUP_NAME_DUPLICATE')
  })

  it('treats NFC and NFD forms as the same name', async () => {
    await service.create('Café')
    expect(await codeOf(service.create('Café'))).toBe('GROUP_NAME_DUPLICATE')
  })

  it('folds non-ASCII case', async () => {
    await service.create('ÉCOLE')
    expect(await codeOf(service.create('école'))).toBe('GROUP_NAME_DUPLICATE')
  })

  it('maps a unique-constraint violation to GROUP_NAME_DUPLICATE when the pre-check misses', async () => {
    await service.create('Storefront')
    vi.spyOn(repo, 'getByNameKey').mockReturnValue(undefined)
    expect(await codeOf(service.create('STOREFRONT'))).toBe('GROUP_NAME_DUPLICATE')
  })

  it('leaves no orphan row when the folder cannot be created', async () => {
    await writeFile(userData, 'x') // userData is a file, so mkdir under it fails
    expect(await codeOf(service.create('Storefront'))).toBe('IO_FAILED')
    expect(repo.list()).toEqual([])
  })
})

describe('GroupService.list', () => {
  it('returns groups in creation order', async () => {
    await service.create('One')
    await service.create('Two')
    await service.create('Three')
    expect(service.list().map((g) => g.name)).toEqual(['One', 'Two', 'Three'])
  })
})

describe('GroupService.rename', () => {
  it('renames, updates updatedAt and keeps id and folder', async () => {
    let t = 100
    const s = new GroupService({
      db: opened.db,
      groupsRepo: repo,
      appDataDir: userData,
      now: () => t
    })
    const g = await s.create('Storefront')
    t = 200
    const renamed = s.rename(g.id, '  Shop ')
    expect(renamed).toEqual({ id: g.id, name: 'Shop', createdAt: 100, updatedAt: 200 })
    expect(repo.getById(g.id)).toMatchObject({ name: 'Shop', nameKey: 'shop', updatedAt: 200 })
    expect(existsSync(join(userData, 'groups', g.id, 'knowledge'))).toBe(true)
    expect(repo.list()).toHaveLength(1)
  })

  it('rejects empty and 61-character names', async () => {
    const g = await service.create('A')
    expect(await codeOf(Promise.resolve().then(() => service.rename(g.id, '  ')))).toBe(
      'GROUP_NAME_REQUIRED'
    )
    expect(await codeOf(Promise.resolve().then(() => service.rename(g.id, 'x'.repeat(61))))).toBe(
      'GROUP_NAME_TOO_LONG'
    )
    expect(repo.getById(g.id)?.name).toBe('A')
  })

  it('rejects another group name case-insensitively', async () => {
    await service.create('Alpha')
    const b = await service.create('Beta')
    expect(await codeOf(Promise.resolve().then(() => service.rename(b.id, 'ALPHA')))).toBe(
      'GROUP_NAME_DUPLICATE'
    )
    expect(repo.getById(b.id)?.name).toBe('Beta')
  })

  it('maps a unique violation to GROUP_NAME_DUPLICATE when the pre-check misses', async () => {
    await service.create('Alpha')
    const b = await service.create('Beta')
    vi.spyOn(repo, 'getByNameKey').mockReturnValue(undefined)
    expect(await codeOf(Promise.resolve().then(() => service.rename(b.id, 'alpha')))).toBe(
      'GROUP_NAME_DUPLICATE'
    )
  })

  it('allows the same name and a case-only change of its own name', async () => {
    const g = await service.create('Storefront')
    expect(service.rename(g.id, 'Storefront').name).toBe('Storefront')
    expect(service.rename(g.id, 'STOREFRONT').name).toBe('STOREFRONT')
  })

  it('fails for an unknown id', async () => {
    expect(
      await codeOf(Promise.resolve().then(() => service.rename('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'X')))
    ).toBe('INTERNAL')
  })
})

describe('GroupService.delete', () => {
  it('removes the row and only its own folder', async () => {
    const a = await service.create('A')
    const b = await service.create('B')
    const decoy = join(userData, 'decoy.txt')
    await writeFile(decoy, 'keep')
    await writeFile(join(userData, 'groups', a.id, 'knowledge', 'f.md'), 'x')

    await service.delete(a.id)

    expect(repo.getById(a.id)).toBeUndefined()
    expect(existsSync(join(userData, 'groups', a.id))).toBe(false)
    expect(repo.getById(b.id)).toBeDefined()
    expect(existsSync(join(userData, 'groups', b.id, 'knowledge'))).toBe(true)
    expect(existsSync(decoy)).toBe(true)
  })

  it('succeeds when the folder is already missing', async () => {
    const a = await service.create('A')
    await removeAppGroupDir(userData, a.id)
    await service.delete(a.id)
    expect(repo.list()).toEqual([])
  })
})

describe('removeAppGroupDir guard', () => {
  it.each(['../x', 'a/b', '', '..', '.', '01ARZ3NDEKTSV4RRFFQ69G5FAV/../..'])(
    'refuses %j and deletes nothing',
    async (id) => {
      const keep = join(userData, 'groups', '01ARZ3NDEKTSV4RRFFQ69G5FAV')
      await mkdir(join(keep, 'knowledge'), { recursive: true })
      await writeFile(join(userData, 'x'), 'decoy')
      await expect(removeAppGroupDir(userData, id)).rejects.toMatchObject({
        code: 'PATH_OUTSIDE_ROOT'
      })
      expect(existsSync(join(keep, 'knowledge'))).toBe(true)
      expect(existsSync(join(userData, 'x'))).toBe(true)
    }
  )

  it('refuses when the resolved path differs from <appData>/groups/<id>', async () => {
    await mkdir(join(userData, 'groups'), { recursive: true })
    await expect(removeAppGroupDir(userData, 'not-a-ulid')).rejects.toMatchObject({
      code: 'PATH_OUTSIDE_ROOT'
    })
    expect(existsSync(join(userData, 'groups'))).toBe(true)
  })
})
