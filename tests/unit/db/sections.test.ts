import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo, isUniqueViolation } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeStorageRepo } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { SectionsRepo } from '../../../src/main/db/repositories/sections-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { sectionNameKey } from '../../../src/shared/sections'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let groups: GroupsRepo
let sections: SectionsRepo
let storage: KnowledgeStorageRepo
let service: GroupService
let userData: string

beforeEach(() => {
  userData = join(dir(), 'userData')
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  groups = new GroupsRepo(opened.db)
  sections = new SectionsRepo(opened.db)
  storage = new KnowledgeStorageRepo(opened.db)
  service = new GroupService({ db: opened.db, groupsRepo: groups, appDataDir: userData })
})
afterEach(() => {
  vi.restoreAllMocks()
  opened.sqlite.close()
})

function section(groupId: string, id: string, kind: 'custom' | 'notes', name: string) {
  return {
    id,
    groupId,
    kind,
    name,
    nameKey: sectionNameKey(name),
    folderName: name,
    sortOrder: 100,
    createdAt: 1
  }
}

function insertRawGroup(db: OpenedDatabase['sqlite'], id: string, name: string): void {
  db.prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)').run(
    id,
    name,
    name.toLowerCase(),
    1,
    1
  )
}

describe('group creation seeding', () => {
  it('creates 5 built-in sections in order, an app storage row and the subfolders', async () => {
    const g = await service.create('Alpha')
    const rows = sections.listByGroup(g.id)
    expect(rows.map((r) => [r.kind, r.name, r.folderName, r.sortOrder])).toEqual([
      ['projects', 'Projects', null, 0],
      ['notes', 'Notes', 'Notes', 1],
      ['docs', 'Docs', 'Docs', 2],
      ['playbooks', 'Playbooks', 'Playbooks', 3],
      ['links', 'Links', 'Links', 4]
    ])
    const st = storage.get(g.id)
    expect(st?.mode).toBe('app')
    expect(st?.linkedPath).toBeNull()
    expect(st?.keptAside).toBe(false)
    for (const f of ['Notes', 'Docs', 'Playbooks', 'Links']) {
      expect(existsSync(join(userData, 'groups', g.id, 'knowledge', f))).toBe(true)
    }
  })

  it('leaves no group row when a seeding step fails midway', async () => {
    vi.spyOn(SectionsRepo.prototype, 'insert').mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(service.create('Alpha')).rejects.toThrow('boom')
    expect(groups.list()).toEqual([])
  })
})

describe('constraints', () => {
  it('rejects a custom section whose name collides with a built-in', async () => {
    const g = await service.create('Alpha')
    let err: unknown
    try {
      sections.insert(section(g.id, 'x1', 'custom', 'docs'))
    } catch (e: unknown) {
      err = e
    }
    expect(isUniqueViolation(err)).toBe(true)
  })

  it('rejects a second built-in kind in the same group but allows distinct customs', async () => {
    const g = await service.create('Alpha')
    let err: unknown
    try {
      sections.insert(section(g.id, 'x1', 'notes', 'Other Notes'))
    } catch (e: unknown) {
      err = e
    }
    expect(isUniqueViolation(err)).toBe(true)
    sections.insert(section(g.id, 'c1', 'custom', 'Alpha Sec'))
    sections.insert(section(g.id, 'c2', 'custom', 'Beta Sec'))
    expect(sections.maxCustomSortOrder(g.id)).toBe(100)
  })

  it('rejects a linked mode without a path and an app mode with a path', async () => {
    const g = await service.create('Alpha')
    expect(() => storage.update(g.id, { mode: 'linked', updatedAt: 2 })).toThrow(/CHECK/)
    expect(() => storage.update(g.id, { linkedPath: '/x', updatedAt: 2 })).toThrow(/CHECK/)
    storage.update(g.id, { mode: 'linked', linkedPath: '/x', updatedAt: 2 })
    expect(storage.get(g.id)?.mode).toBe('linked')
  })

  it('cascades sections and storage when the group is deleted', async () => {
    const g = await service.create('Alpha')
    groups.delete(g.id)
    expect(sections.listByGroup(g.id)).toEqual([])
    expect(storage.get(g.id)).toBeUndefined()
  })
})

describe('backfill migration', () => {
  it('seeds groups that existed before 0001, and is safe to re-run', () => {
    const folder = join(dir(), 'm-two-step')
    cpSync(realMigrations, folder, { recursive: true })
    const journalPath = join(folder, 'meta', '_journal.json')
    const full = readFileSync(journalPath, 'utf8')
    const parsed = JSON.parse(full) as { entries: unknown[] }
    writeFileSync(journalPath, JSON.stringify({ ...parsed, entries: parsed.entries.slice(0, 1) }))
    const dbPath = join(dir(), 'old.db')
    const old = openDatabase({ dbPath, migrationsFolder: folder })
    insertRawGroup(old.sqlite, 'G1', 'Legacy')
    old.sqlite.close()

    writeFileSync(journalPath, full)
    const upgraded = openDatabase({ dbPath, migrationsFolder: folder })
    try {
      const s = new SectionsRepo(upgraded.db).listByGroup('G1')
      expect(s.map((r) => r.kind)).toEqual(['projects', 'notes', 'docs', 'playbooks', 'links'])
      expect(s[1]).toMatchObject({ name: 'Notes', nameKey: 'notes', folderName: 'Notes' })
      expect(new KnowledgeStorageRepo(upgraded.db).get('G1')?.mode).toBe('app')

      // Re-running the backfill statements must not add duplicates.
      const sql = readFileSync(join(folder, '0001_sections_storage.sql'), 'utf8')
      const backfill = sql.slice(sql.indexOf('INSERT INTO `sections`'))
      upgraded.sqlite.exec(backfill)
      expect(new SectionsRepo(upgraded.db).listByGroup('G1')).toHaveLength(5)
    } finally {
      upgraded.sqlite.close()
    }
  })
})
