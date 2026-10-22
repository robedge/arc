import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import {
  KnowledgeStorageRepo,
  PendingOpConflictError,
  StorageRowNotFoundError
} from '../../../src/main/db/repositories/knowledge-storage-repo'
import type { PendingOpInput } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { useTempDir } from '../helpers/temp-dir'
import { realMigrations } from './helpers'

const dir = useTempDir()
let opened: OpenedDatabase
let repo: KnowledgeStorageRepo

function addGroup(id: string, mode: 'app' | 'linked' = 'app'): void {
  opened.sqlite
    .prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(id, id, id, 1, 1)
  repo.insert({
    groupId: id,
    mode,
    linkedPath: mode === 'linked' ? '/linked/a' : null,
    updatedAt: 1
  })
}

const moveOp: PendingOpInput = {
  kind: 'link-move',
  sourceRoot: '/app/g1/knowledge',
  targetRoot: '/linked/a',
  manifestPath: '/app/g1/run.json',
  startedAt: 100
}

beforeEach(() => {
  opened = openDatabase({ dbPath: join(dir(), 'arc.db'), migrationsFolder: realMigrations })
  repo = new KnowledgeStorageRepo(opened.db)
  addGroup('g1')
  addGroup('g2')
})
afterEach(() => {
  opened.sqlite.close()
})

describe('pending_op', () => {
  it('begins, reads back with defaults applied, and clears', () => {
    const op = repo.beginPendingOp('g1', moveOp, 200)
    expect(op.createdFiles).toEqual([])
    expect(repo.getPendingOp('g1')).toEqual({ ...moveOp, createdFiles: [] })
    expect(repo.get('g1')?.updatedAt).toBe(200)
    repo.clearPendingOp('g1', 300)
    expect(repo.getPendingOp('g1')).toBeNull()
    expect(repo.get('g1')?.pendingOp).toBeNull()
  })

  it('allows only one pending op per group but one per group overall', () => {
    repo.beginPendingOp('g1', moveOp)
    expect(() => repo.beginPendingOp('g1', { ...moveOp, kind: 'unlink-restore' })).toThrow(
      PendingOpConflictError
    )
    expect(repo.getPendingOp('g1')?.kind).toBe('link-move')
    expect(() => repo.beginPendingOp('g2', moveOp)).not.toThrow()
  })

  it('rejects begin on a missing group row and invalid input', () => {
    expect(() => repo.beginPendingOp('nope', moveOp)).toThrow(StorageRowNotFoundError)
    expect(() =>
      repo.beginPendingOp('g1', { ...moveOp, kind: 'bogus' } as unknown as PendingOpInput)
    ).toThrow()
    expect(repo.getPendingOp('g1')).toBeNull()
  })

  it('updates the op in place and refuses when none is pending', () => {
    expect(() => repo.updatePendingOp('g1', moveOp)).toThrow()
    repo.beginPendingOp('g1', moveOp)
    repo.updatePendingOp('g1', { ...moveOp, createdFiles: ['/linked/a/Notes/x.md'] })
    expect(repo.getPendingOp('g1')?.createdFiles).toEqual(['/linked/a/Notes/x.md'])
  })

  it('lists pending ops and surfaces corrupt markers with op null', () => {
    repo.beginPendingOp('g1', moveOp)
    opened.sqlite
      .prepare("UPDATE knowledge_storage SET pending_op='{bad' WHERE group_id='g2'")
      .run()
    const list = repo.listPendingOps().sort((a, b) => a.groupId.localeCompare(b.groupId))
    expect(list.map((e) => e.groupId)).toEqual(['g1', 'g2'])
    expect(list[0]?.op?.kind).toBe('link-move')
    expect(list[1]).toMatchObject({ op: null, raw: '{bad' })
    expect(repo.getPendingOp('g2')).toBeNull()
    expect(() => repo.beginPendingOp('g2', moveOp)).toThrow(PendingOpConflictError)
  })

  it('lists nothing when no op is pending', () => {
    expect(repo.listPendingOps()).toEqual([])
  })
})

describe('kept_aside', () => {
  it('sets, reads and clears with a timestamp', () => {
    expect(repo.getKeptAside('g1')).toEqual({ keptAside: false, since: null })
    repo.setKeptAside('g1', 500)
    expect(repo.getKeptAside('g1')).toEqual({ keptAside: true, since: 500 })
    repo.clearKeptAside('g1', 600)
    expect(repo.getKeptAside('g1')).toEqual({ keptAside: false, since: null })
    expect(repo.getKeptAside('nope')).toBeUndefined()
  })
})

describe('flipStorage', () => {
  it('flips to linked with kept-aside and clears pending_op in one step', () => {
    repo.beginPendingOp('g1', { ...moveOp, kind: 'link-folder-only' })
    repo.flipStorage('g1', { mode: 'linked', linkedPath: '/linked/b', keptAside: true }, 700)
    expect(repo.get('g1')).toMatchObject({
      mode: 'linked',
      linkedPath: '/linked/b',
      keptAside: true,
      keptAsideAt: 700,
      pendingOp: null,
      updatedAt: 700
    })
  })

  it('flips back to app and drops kept-aside', () => {
    repo.flipStorage('g1', { mode: 'linked', linkedPath: '/l', keptAside: true }, 10)
    repo.flipStorage('g1', { mode: 'app', keptAside: false }, 20)
    expect(repo.get('g1')).toMatchObject({
      mode: 'app',
      linkedPath: null,
      keptAside: false,
      keptAsideAt: null
    })
  })

  it('keeps the original kept-aside time when relocating a still-kept group', () => {
    repo.flipStorage('g1', { mode: 'linked', linkedPath: '/l', keptAside: true }, 10)
    repo.flipStorage('g1', { mode: 'linked', linkedPath: '/m', keptAside: true }, 20)
    expect(repo.get('g1')?.keptAsideAt).toBe(10)
  })

  it('rolls everything back when the flip fails midway', () => {
    repo.beginPendingOp('g1', moveOp)
    // linked mode with an empty-string path is allowed by the CHECK; force a failure with a bad mode.
    expect(() => repo.flipStorage('g1', { mode: 'bogus', keptAside: true } as never, 800)).toThrow()
    expect(repo.get('g1')).toMatchObject({ mode: 'app', keptAside: false })
    expect(repo.getPendingOp('g1')).not.toBeNull()
  })

  it('throws for a missing row and works inside an outer transaction', () => {
    expect(() => repo.flipStorage('nope', { mode: 'app', keptAside: false })).toThrow(
      StorageRowNotFoundError
    )
    opened.db.transaction((tx) => {
      new KnowledgeStorageRepo(tx).flipStorage('g2', {
        mode: 'linked',
        linkedPath: '/x',
        keptAside: false
      })
    })
    expect(repo.get('g2')?.mode).toBe('linked')
  })
})

describe('migration 0004 on a database already at 0003', () => {
  it('adds kept_aside_at and preserves existing rows', () => {
    const old = join(dir(), 'old-migrations')
    cpSync(realMigrations, old, { recursive: true })
    const jp = join(old, 'meta', '_journal.json')
    const journal = JSON.parse(readFileSync(jp, 'utf8')) as { entries: { tag: string }[] }
    journal.entries = journal.entries.filter((e) => e.tag <= '0003_knowledge_items')
    mkdirSync(join(old, 'meta'), { recursive: true })
    writeFileSync(jp, JSON.stringify(journal))

    const dbPath = join(dir(), 'upgrade.db')
    const at3 = openDatabase({ dbPath, migrationsFolder: old })
    at3.sqlite
      .prepare('INSERT INTO groups (id,name,name_key,created_at,updated_at) VALUES (?,?,?,?,?)')
      .run('old', 'Old', 'old', 1, 1)
    at3.sqlite
      .prepare(
        "INSERT INTO knowledge_storage (group_id,mode,linked_path,kept_aside,pending_op,updated_at) VALUES ('old','linked','/p',1,NULL,5)"
      )
      .run()
    at3.sqlite.close()

    const upgraded = openDatabase({ dbPath, migrationsFolder: realMigrations })
    try {
      expect(upgraded.backupPath).toMatch(/upgrade\.db\.bak-0003_knowledge_items$/)
      const row = new KnowledgeStorageRepo(upgraded.db).get('old')
      expect(row).toMatchObject({
        mode: 'linked',
        linkedPath: '/p',
        keptAside: true,
        keptAsideAt: null
      })
      new KnowledgeStorageRepo(upgraded.db).flipStorage('old', { mode: 'app', keptAside: false })
      expect(new KnowledgeStorageRepo(upgraded.db).get('old')?.mode).toBe('app')
    } finally {
      upgraded.sqlite.close()
    }
  })
})
