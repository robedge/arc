import { existsSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeStorageRepo } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { SectionsRepo } from '../../../src/main/db/repositories/sections-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { createKnowledgeRootResolver } from '../../../src/main/knowledge/knowledge-root'
import { MetaStore } from '../../../src/main/knowledge/meta-store'
import { SectionService } from '../../../src/main/knowledge/section-service'
import { AppErrorException } from '../../../src/shared/errors'
import type { ErrorCode } from '../../../src/shared/errors'
import { realMigrations } from '../db/helpers'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
let opened: OpenedDatabase
let service: SectionService
let userData: string
let groupId: string
let root: string

beforeEach(async () => {
  userData = join(dir(), 'userData')
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  const groups = new GroupService({
    db: opened.db,
    groupsRepo: new GroupsRepo(opened.db),
    appDataDir: userData
  })
  groupId = (await groups.create('Storefront')).id
  root = join(userData, 'groups', groupId, 'knowledge')
  service = new SectionService({
    sectionsRepo: new SectionsRepo(opened.db),
    getKnowledgeRoot: createKnowledgeRootResolver({
      storageRepo: new KnowledgeStorageRepo(opened.db),
      appDataDir: userData
    }),
    metaStore: new MetaStore({ log: { warn: () => undefined } })
  })
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

describe('SectionService.list', () => {
  it('returns the five built-ins with itemCount 0', async () => {
    const list = await service.list(groupId)
    expect(list.map((s) => s.name)).toEqual(['Projects', 'Notes', 'Docs', 'Playbooks', 'Links'])
    expect(list.every((s) => s.builtIn && s.itemCount === 0 && s.groupId === groupId)).toBe(true)
  })

  it('counts regular files, ignoring dotfiles, temp files and subfolders', async () => {
    const notes = join(root, 'Notes')
    await writeFile(join(notes, 'a.md'), 'x')
    await writeFile(join(notes, 'b.md'), 'x')
    await writeFile(join(notes, '.tmp-abc-c.md'), 'x')
    await mkdir(join(notes, 'sub'))
    const list = await service.list(groupId)
    expect(list.find((s) => s.name === 'Notes')?.itemCount).toBe(2)
  })
})

describe('SectionService.create', () => {
  it('creates the folder and lists it after the built-ins', async () => {
    const created = await service.create(groupId, '  Runbooks ')
    expect(created).toMatchObject({
      name: 'Runbooks',
      kind: 'custom',
      builtIn: false,
      itemCount: 0
    })
    expect(created.sortOrder).toBeGreaterThanOrEqual(100)
    expect(existsSync(join(root, 'Runbooks'))).toBe(true)
    const names = (await service.list(groupId)).map((s) => s.name)
    expect(names).toEqual(['Projects', 'Notes', 'Docs', 'Playbooks', 'Links', 'Runbooks'])
    const meta = JSON.parse(await readFile(join(root, '.arc', 'meta.json'), 'utf8')) as {
      sections: { folder: string }[]
    }
    expect(meta.sections.map((s) => s.folder)).toEqual([
      'Notes',
      'Docs',
      'Playbooks',
      'Links',
      'Runbooks'
    ])
  })

  it('orders later custom sections after earlier ones', async () => {
    const a = await service.create(groupId, 'A')
    const b = await service.create(groupId, 'B')
    expect(b.sortOrder).toBe(a.sortOrder + 1)
  })

  it.each(['runbooks', 'Docs', 'DOCS', 'projects'])('rejects duplicate %s', async (name) => {
    await service.create(groupId, 'Runbooks')
    expect(await codeOf(service.create(groupId, name))).toBe('SECTION_NAME_DUPLICATE')
  })

  it('rejects empty, 41-character and unsanitizable names, accepts 40', async () => {
    expect(await codeOf(service.create(groupId, '   '))).toBe('SECTION_NAME_INVALID')
    expect(await codeOf(service.create(groupId, 'x'.repeat(41)))).toBe('SECTION_NAME_INVALID')
    expect(await codeOf(service.create(groupId, '...'))).toBe('SECTION_NAME_INVALID')
    expect(await codeOf(service.create(groupId, 'y'.repeat(40)))).toBeUndefined()
  })

  it('picks a unique folder when an unregistered folder already exists', async () => {
    await mkdir(join(root, 'runbooks'))
    const created = await service.create(groupId, 'Runbooks')
    expect(created.name).toBe('Runbooks')
    expect(existsSync(join(root, 'Runbooks (2)'))).toBe(true)
  })

  it('removes the row when the folder cannot be created', async () => {
    await chmod(root, 0o500)
    try {
      expect(await codeOf(service.create(groupId, 'Blocked'))).toBe('IO_FAILED')
    } finally {
      await chmod(root, 0o700)
    }
    expect((await service.list(groupId)).map((s) => s.name)).not.toContain('Blocked')
  })
})

describe('SectionService.rename', () => {
  it('moves the folder and updates the name', async () => {
    const s = await service.create(groupId, 'Runbooks')
    await writeFile(join(root, 'Runbooks', 'a.md'), 'x')
    const renamed = await service.rename(s.id, 'Runbook Notes')
    expect(renamed).toMatchObject({ id: s.id, name: 'Runbook Notes', itemCount: 1 })
    expect(existsSync(join(root, 'Runbooks'))).toBe(false)
    expect(existsSync(join(root, 'Runbook Notes', 'a.md'))).toBe(true)
  })

  it('applies a case-only rename to the folder on disk', async () => {
    const s = await service.create(groupId, 'Runbooks')
    await writeFile(join(root, 'Runbooks', 'a.md'), 'x')
    const renamed = await service.rename(s.id, 'RUNBOOKS')
    expect(renamed.name).toBe('RUNBOOKS')
    const entries = await readdir(root)
    expect(entries).toContain('RUNBOOKS')
    expect(entries).not.toContain('Runbooks')
    expect(entries.some((e) => e.includes('rename-tmp'))).toBe(false)
    expect(existsSync(join(root, 'RUNBOOKS', 'a.md'))).toBe(true)
  })

  it('rejects duplicates of other sections and built-in names', async () => {
    await service.create(groupId, 'Alpha')
    const b = await service.create(groupId, 'Beta')
    expect(await codeOf(service.rename(b.id, 'alpha'))).toBe('SECTION_NAME_DUPLICATE')
    expect(await codeOf(service.rename(b.id, 'Notes'))).toBe('SECTION_NAME_DUPLICATE')
    expect(existsSync(join(root, 'Beta'))).toBe(true)
  })

  it('rejects invalid names and leaves the folder alone', async () => {
    const s = await service.create(groupId, 'Alpha')
    expect(await codeOf(service.rename(s.id, 'x'.repeat(41)))).toBe('SECTION_NAME_INVALID')
    expect(existsSync(join(root, 'Alpha'))).toBe(true)
  })

  it('rejects built-in sections', async () => {
    const notes = (await service.list(groupId)).find((s) => s.name === 'Notes')
    expect(await codeOf(service.rename(notes?.id ?? '', 'Journal'))).toBe('VALIDATION_FAILED')
    expect(existsSync(join(root, 'Notes'))).toBe(true)
  })
})

describe('SectionService.delete', () => {
  it('removes the folder and its files but not siblings', async () => {
    const s = await service.create(groupId, 'Runbooks')
    for (const n of ['a.md', 'b.md', 'c.md']) await writeFile(join(root, 'Runbooks', n), 'x')
    await writeFile(join(root, 'Notes', 'keep.md'), 'x')
    expect(await service.delete(s.id)).toEqual({ removed: 3 })
    expect(existsSync(join(root, 'Runbooks'))).toBe(false)
    expect(existsSync(join(root, 'Notes', 'keep.md'))).toBe(true)
    expect(existsSync(root)).toBe(true)
    expect((await service.list(groupId)).map((x) => x.name)).not.toContain('Runbooks')
  })

  it('rejects built-in sections and unknown ids', async () => {
    const docs = (await service.list(groupId)).find((s) => s.name === 'Docs')
    expect(await codeOf(service.delete(docs?.id ?? ''))).toBe('VALIDATION_FAILED')
    expect(existsSync(join(root, 'Docs'))).toBe(true)
    expect(await codeOf(service.delete('nope'))).toBe('INTERNAL')
  })
})
