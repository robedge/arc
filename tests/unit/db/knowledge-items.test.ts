import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { isUniqueViolation } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeItemsRepo } from '../../../src/main/db/repositories/knowledge-items-repo'
import type { KnowledgeItemInput } from '../../../src/main/db/repositories/knowledge-items-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: KnowledgeItemsRepo

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  repo = new KnowledgeItemsRepo(opened.db)
  for (const g of ['g1', 'g2']) {
    opened.sqlite
      .prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run(g, g, g, 1, 1)
    for (const s of ['a', 'b']) {
      opened.sqlite
        .prepare(
          'INSERT INTO sections (id,group_id,kind,name,name_key,folder_name,sort_order,created_at) VALUES (?,?,?,?,?,?,?,?)'
        )
        .run(`${g}-${s}`, g, 'custom', s, s, s, 100, 1)
    }
  }
})
afterEach(() => {
  opened.sqlite.close()
})

function item(over: Partial<KnowledgeItemInput> = {}): KnowledgeItemInput {
  return {
    groupId: 'g1',
    sectionId: 'g1-a',
    relPath: 'a/One.md',
    kind: 'note',
    title: 'One',
    description: null,
    url: null,
    mime: 'text/markdown',
    sizeBytes: 10,
    mtimeMs: 100,
    contentHash: null,
    isEditable: true,
    indexedAt: 1,
    ...over
  }
}

function count(): number {
  return (opened.sqlite.prepare('SELECT count(*) AS c FROM knowledge_items').get() as { c: number })
    .c
}

describe('KnowledgeItemsRepo', () => {
  it('upserts by rel_path keeping the id and updating fields', () => {
    const first = repo.upsertByRelPath(item())
    expect(first.id).toHaveLength(26)
    const second = repo.upsertByRelPath(
      item({ title: 'Renamed', sizeBytes: 99, isEditable: false, description: 'd' })
    )
    expect(second.id).toBe(first.id)
    expect(second).toMatchObject({
      title: 'Renamed',
      sizeBytes: 99,
      isEditable: false,
      description: 'd'
    })
    expect(count()).toBe(1)
    expect(repo.getById(first.id)).toEqual(second)
  })

  it('allows the same rel_path in different groups', () => {
    const a = repo.upsertByRelPath(item())
    const b = repo.upsertByRelPath(item({ groupId: 'g2', sectionId: 'g2-a' }))
    expect(a.id).not.toBe(b.id)
    expect(repo.getByRelPath('g2', 'a/One.md')?.id).toBe(b.id)
    expect(count()).toBe(2)
  })

  it('deleteMissing removes only unlisted rows of the given section', () => {
    repo.upsertByRelPath(item({ relPath: 'a/keep.md', title: 'keep' }))
    repo.upsertByRelPath(item({ relPath: 'a/gone.md', title: 'gone' }))
    repo.upsertByRelPath(item({ sectionId: 'g1-b', relPath: 'b/other.md', title: 'other' }))
    repo.deleteMissing('g1', 'g1-a', ['a/keep.md'])
    expect(repo.listBySection('g1-a').map((r) => r.relPath)).toEqual(['a/keep.md'])
    expect(repo.countBySection('g1-b')).toBe(1)
    repo.deleteMissing('g1', 'g1-a', [])
    expect(repo.countBySection('g1-a')).toBe(0)
    expect(repo.countBySection('g1-b')).toBe(1)
  })

  it('lists by title case-insensitively and deletes by rel_path', () => {
    repo.upsertByRelPath(item({ relPath: 'a/1.md', title: 'beta' }))
    repo.upsertByRelPath(item({ relPath: 'a/2.md', title: 'Alpha' }))
    repo.upsertByRelPath(item({ relPath: 'a/3.md', title: 'charlie' }))
    expect(repo.listBySection('g1-a').map((r) => r.title)).toEqual(['Alpha', 'beta', 'charlie'])
    repo.deleteByRelPath('g1', 'a/1.md')
    expect(repo.getByRelPath('g1', 'a/1.md')).toBeUndefined()
  })

  it('renameRelPath keeps the id and fails on an existing target', () => {
    const one = repo.upsertByRelPath(item())
    repo.upsertByRelPath(item({ relPath: 'a/Two.md', title: 'Two' }))
    repo.renameRelPath('g1', 'a/One.md', 'a/Uno.md')
    expect(repo.getByRelPath('g1', 'a/Uno.md')?.id).toBe(one.id)
    let error: unknown
    try {
      repo.renameRelPath('g1', 'a/Uno.md', 'a/Two.md')
    } catch (e) {
      error = e
    }
    expect(isUniqueViolation(error)).toBe(true)
  })

  it('cascades when a section or a group is deleted', () => {
    repo.upsertByRelPath(item())
    repo.upsertByRelPath(item({ sectionId: 'g1-b', relPath: 'b/x.md' }))
    repo.upsertByRelPath(item({ groupId: 'g2', sectionId: 'g2-a' }))
    opened.sqlite.prepare("DELETE FROM sections WHERE id='g1-a'").run()
    expect(repo.countBySection('g1-a')).toBe(0)
    expect(count()).toBe(2)
    opened.sqlite.prepare("DELETE FROM groups WHERE id='g1'").run()
    expect(count()).toBe(1)
  })

  it('rejects an unknown kind', () => {
    expect(() => repo.upsertByRelPath(item({ kind: 'bogus' as never }))).toThrow(/CHECK/)
  })
})
