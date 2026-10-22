import { mkdir, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { exportFolderName } from '../../../src/main/knowledge/knowledge-export'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf } from './knowledge-test-env'
import { exists, fingerprint, put, setup, tree } from './storage-test-harness'
import type { StorageHarness } from './storage-test-harness'

const tempDir = useTempDir('harness-export-')

async function seeded(): Promise<{ h: StorageHarness; dir: string; dest: string }> {
  const dir = await realpath(tempDir())
  const h = await setup(dir)
  await put(h.env.root, 'Notes/Plan.md', '# Plan\nbody')
  await put(h.env.root, 'Docs/Spec.md', '# Spec')
  await put(h.env.root, 'Links/Site.md', 'https://example.com')
  await put(h.env.root, 'Runbooks/Deploy.md', '# Deploy')
  await put(h.env.root, '.arc/meta.json', '{"version":1}')
  const dest = join(dir, 'out')
  await mkdir(dest)
  return { h, dir, dest }
}

async function pick(h: StorageHarness, dest: string): Promise<string> {
  h.picks.push([dest])
  const r = await h.service.pickExportFolder(h.env.groupId)
  if (!r.picked || r.token === null) throw new Error(`pick failed: ${JSON.stringify(r)}`)
  return r.token
}

function groupServiceFor(h: StorageHarness, dir: string): GroupService {
  return new GroupService({
    db: h.env.opened.db,
    groupsRepo: new GroupsRepo(h.env.opened.db),
    appDataDir: join(dir, 'userData'),
    exportKnowledge: (id, token) => h.service.exportKnowledge(id, token),
    withStorageLock: (id, task) => h.service.withLock(id, task)
  })
}

describe('exportFolderName', () => {
  it.each([
    ['Shop', 'Shop-knowledge'],
    ['a/b:c', 'a-b-c-knowledge'],
    ['..hidden', 'hidden-knowledge'],
    ['  ', 'Group-knowledge'],
    ['x\u0000y\n', 'x-y-knowledge']
  ])('%j -> %j', (input, expected) => {
    expect(exportFolderName(input)).toBe(expected)
  })
})

describe('storage export', () => {
  it('copies notes, docs, links, custom sections and .arc, verified', async () => {
    const { h, dest } = await seeded()
    const before = await tree(h.env.root)
    const result = await h.service.exportKnowledge(h.env.groupId, await pick(h, dest))
    expect(result.path).toBe(join(dest, 'Storefront-knowledge'))
    expect(result.count).toBe(5)
    expect(await tree(result.path)).toEqual(before)
    expect(h.progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['preparing', 'exporting', 'verifying', 'done'])
    )
  })

  it('uses a unique folder name and never overwrites', async () => {
    const { h, dest } = await seeded()
    const first = await h.service.exportKnowledge(h.env.groupId, await pick(h, dest))
    await put(first.path, 'Notes/Plan.md', 'EDITED')
    const second = await h.service.exportKnowledge(h.env.groupId, await pick(h, dest))
    expect(second.path).toBe(join(dest, 'Storefront-knowledge (2)'))
    expect((await tree(first.path))['Notes/Plan.md']).toBe('EDITED')
  })

  it('rejects an unknown, reused or other-group token', async () => {
    const { h, dest } = await seeded()
    const token = await pick(h, dest)
    await h.service.exportKnowledge(h.env.groupId, token)
    expect(await codeOf(h.service.exportKnowledge(h.env.groupId, token))).toBe(
      'STORAGE_TARGET_INVALID'
    )
    expect(await codeOf(h.service.exportKnowledge(h.env.groupId, 'nope'))).toBe(
      'STORAGE_TARGET_INVALID'
    )
  })

  it('blocks a destination inside the knowledge root', async () => {
    const { h } = await seeded()
    h.picks.push([join(h.env.root, 'Notes')])
    const r = await h.service.pickExportFolder(h.env.groupId)
    expect(r).toMatchObject({ picked: true, token: null })
  })

  it('returns picked:false when the picker is cancelled', async () => {
    const { h } = await seeded()
    h.picks.push(null)
    expect(await h.service.pickExportFolder(h.env.groupId)).toEqual({ picked: false })
  })

  it('removes the partial export and throws EXPORT_FAILED when the copy fails midway', async () => {
    const dir = await realpath(tempDir())
    let calls = 0
    const h = await setup(dir, {
      fs: {
        copyFile: (src, dest, mode) => {
          calls++
          if (calls === 3) return Promise.reject(new Error('disk full'))
          return import('node:fs/promises').then((m) => m.copyFile(src, dest, mode))
        }
      }
    })
    await put(h.env.root, 'Notes/A.md', 'a')
    await put(h.env.root, 'Notes/B.md', 'b')
    await put(h.env.root, 'Docs/C.md', 'c')
    await put(h.env.root, 'Docs/D.md', 'd')
    const dest = join(dir, 'out')
    await mkdir(dest)
    expect(await codeOf(h.service.exportKnowledge(h.env.groupId, await pick(h, dest)))).toBe(
      'EXPORT_FAILED'
    )
    expect(await readdir(dest)).toEqual([])
    expect(h.service.isLocked(h.env.groupId)).toBe(false)
  })

  it('fails verification when a copied file has the wrong size', async () => {
    const dir = await realpath(tempDir())
    const h = await setup(dir, {
      fs: {
        copyFile: async (src, dest) => {
          const { writeFile } = await import('node:fs/promises')
          await writeFile(dest, 'truncated')
        }
      }
    })
    await put(h.env.root, 'Notes/A.md', 'a much longer body than the stub')
    const dest = join(dir, 'out')
    await mkdir(dest)
    expect(await codeOf(h.service.exportKnowledge(h.env.groupId, await pick(h, dest)))).toBe(
      'EXPORT_FAILED'
    )
    expect(await readdir(dest)).toEqual([])
  })

  it('exports a linked group from the linked folder and leaves it untouched', async () => {
    const { h, dest } = await seeded()
    await put(h.target, 'Notes/Linked.md', '# Linked')
    await put(h.target, '.arc/meta.json', '{"version":1}')
    await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    const before = await fingerprint(h.target)
    const result = await h.service.exportKnowledge(h.env.groupId, await pick(h, dest))
    expect(Object.keys(await tree(result.path)).sort()).toEqual([
      '.arc/meta.json',
      'Notes/Linked.md'
    ])
    expect(await fingerprint(h.target)).toEqual(before)
  })

  it('reports a missing linked folder clearly', async () => {
    const { h, dest } = await seeded()
    await put(h.target, 'Notes/Linked.md', '# Linked')
    await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    const token = await pick(h, dest)
    const { rm } = await import('node:fs/promises')
    await rm(h.target, { recursive: true })
    expect(await codeOf(h.service.exportKnowledge(h.env.groupId, token))).toBe(
      'KNOWLEDGE_ROOT_MISSING'
    )
    expect(await readdir(dest)).toEqual([])
  })

  it('holds the per-group storage lock while exporting', async () => {
    const { h, dest } = await seeded()
    const token = await pick(h, dest)
    const running = h.service.exportKnowledge(h.env.groupId, token)
    expect(h.service.isLocked(h.env.groupId)).toBe(true)
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('STORAGE_BUSY')
    await running
    expect(h.service.isLocked(h.env.groupId)).toBe(false)
  })
})

describe('groups:delete with exportTo', () => {
  it('exports, verifies, then deletes the group and its app folder', async () => {
    const { h, dir, dest } = await seeded()
    const groups = groupServiceFor(h, dir)
    await groups.delete(h.env.groupId, await pick(h, dest))
    expect(await tree(join(dest, 'Storefront-knowledge'))).toHaveProperty('Docs/Spec.md')
    expect(new GroupsRepo(h.env.opened.db).getById(h.env.groupId)).toBeUndefined()
    expect(await exists(h.groupDir)).toBe(false)
  })

  it('aborts the delete when the export fails', async () => {
    const dir = await realpath(tempDir())
    const h = await setup(dir, { fs: { copyFile: () => Promise.reject(new Error('boom')) } })
    await put(h.env.root, 'Notes/A.md', 'a')
    const dest = join(dir, 'out')
    await mkdir(dest)
    const groups = groupServiceFor(h, dir)
    expect(await codeOf(groups.delete(h.env.groupId, await pick(h, dest)))).toBe('EXPORT_FAILED')
    expect(new GroupsRepo(h.env.opened.db).getById(h.env.groupId)).toBeDefined()
    expect(await exists(join(h.env.root, 'Notes/A.md'))).toBe(true)
    expect(await readdir(dest)).toEqual([])
  })

  it('aborts the delete on an invalid token', async () => {
    const { h, dir } = await seeded()
    const groups = groupServiceFor(h, dir)
    expect(await codeOf(groups.delete(h.env.groupId, 'bad'))).toBe('STORAGE_TARGET_INVALID')
    expect(new GroupsRepo(h.env.opened.db).getById(h.env.groupId)).toBeDefined()
  })

  it('never touches a linked folder, but removes the app dir including knowledge.kept', async () => {
    const { h, dir } = await seeded()
    await put(h.target, 'Notes/Linked.md', '# Linked')
    await put(h.target, '.arc/meta.json', '{"version":1}')
    await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(true)
    const before = await fingerprint(h.target)
    const stopped: string[] = []
    const groups = new GroupService({
      db: h.env.opened.db,
      groupsRepo: new GroupsRepo(h.env.opened.db),
      appDataDir: join(dir, 'userData'),
      stopWatcher: (id) => {
        stopped.push(id)
        return Promise.resolve()
      }
    })
    await groups.delete(h.env.groupId)
    expect(stopped).toEqual([h.env.groupId])
    expect(await fingerprint(h.target)).toEqual(before)
    expect(await exists(h.groupDir)).toBe(false)
    expect(new GroupsRepo(h.env.opened.db).getById(h.env.groupId)).toBeUndefined()
  })
})
