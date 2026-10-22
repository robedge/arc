import { constants } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeStorageRepo } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import {
  KnowledgeStorageService,
  moveDirectory,
  rollbackManifest
} from '../../../src/main/knowledge/knowledge-storage-service'
import type {
  FsOps,
  KnowledgeStorageServiceDeps
} from '../../../src/main/knowledge/knowledge-storage-service'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf, createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

const tempDir = useTempDir('harness-storage-')

type Progress = IpcEvents['storage:progress']
type Changed = IpcEvents['knowledge:changed']

interface Harness {
  env: KnowledgeEnv
  service: KnowledgeStorageService
  storageRepo: KnowledgeStorageRepo
  userData: string
  target: string
  progress: Progress[]
  changed: Changed[]
  watcher: { calls: string[]; watchedGroupId: string | null }
  picks: (string[] | null)[]
  warn: ReturnType<typeof vi.fn>
}

async function setup(
  options: {
    fs?: Partial<FsOps>
    storageRepoWrap?: (repo: KnowledgeStorageRepo) => KnowledgeStorageServiceDeps['storageRepo']
  } = {}
): Promise<Harness> {
  const dir = tempDir()
  const env = await createEnv(dir)
  const userData = join(dir, 'userData')
  const target = join(dir, 'ext', 'target')
  await mkdir(target, { recursive: true })
  const storageRepo = new KnowledgeStorageRepo(env.opened.db)
  const progress: Progress[] = []
  const changed: Changed[] = []
  const picks: (string[] | null)[] = []
  const calls: string[] = []
  const watcher = {
    calls,
    watchedGroupId: env.groupId as string | null,
    pause: () => calls.push('pause'),
    resume: () => {
      calls.push('resume')
      return Promise.resolve()
    },
    start: (id: string) => {
      calls.push(`start:${id}`)
      return Promise.resolve()
    }
  }
  const warn = vi.fn()
  const service = new KnowledgeStorageService({
    storageRepo: options.storageRepoWrap ? options.storageRepoWrap(storageRepo) : storageRepo,
    projectsRepo: new ProjectsRepo(env.opened.db),
    sectionsRepo: env.sectionsRepo,
    metaStore: env.metaStore,
    dialogs: { pickFolders: () => Promise.resolve(picks.shift() ?? null) },
    groupsRepo: new GroupsRepo(env.opened.db),
    watcher,
    index: env.index,
    adoptFolders: (id) => env.sections.adoptFolders(id),
    listGroupIds: () => new GroupsRepo(env.opened.db).list().map((g) => g.id),
    appDataDir: userData,
    emit: ((event: string, payload: unknown) => {
      if (event === 'storage:progress') progress.push(payload as Progress)
      else changed.push(payload as Changed)
    }) as KnowledgeStorageServiceDeps['emit'],
    log: { warn },
    ...(options.fs ? { fs: options.fs } : {})
  })
  return { env, service, storageRepo, userData, target, progress, changed, watcher, picks, warn }
}

async function put(root: string, rel: string, text: string): Promise<void> {
  const path = join(root, ...rel.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

/** relative path -> text for every file below root (dot entries included). */
async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`)
      else out[`${prefix}${e.name}`] = await readFile(join(dir, e.name), 'utf8')
    }
  }
  await walk(root, '')
  return out
}

async function dirNames(root: string): Promise<string[]> {
  return (await readdir(root)).sort()
}

function titles(h: Harness, sectionId: string): string[] {
  return h.env.itemsRepo
    .listBySection(sectionId)
    .map((r) => r.title)
    .sort()
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

describe('KnowledgeStorageService link: move existing knowledge', () => {
  it('copies every file, flips to linked, empties the source and reports progress', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Alpha.md', '# Alpha\none')
    await put(h.env.root, 'Notes/Beta.md', '# Beta\ntwo')
    await h.env.index.reconcileGroup(h.env.groupId)

    const state = await h.service.linkPath(h.env.groupId, h.target, 'move')

    const real = await realpath(h.target)
    expect(state).toMatchObject({ mode: 'linked', linkedPath: real, keptAside: false })
    const files = await tree(h.target)
    expect(files['Notes/Alpha.md']).toBe('# Alpha\none')
    expect(files['Notes/Beta.md']).toBe('# Beta\ntwo')
    expect(await readdir(h.env.root)).toEqual([]) // source emptied
    expect(h.storageRepo.get(h.env.groupId)?.pendingOp).toBeNull()
    expect(await exists(join(h.userData, 'groups', h.env.groupId, 'storage-op.json'))).toBe(false)
    expect(titles(h, h.env.notesId)).toEqual(['Alpha', 'Beta'])
    // the section folders exist in the target even when empty
    expect(await dirNames(h.target)).toEqual(
      expect.arrayContaining(['Docs', 'Links', 'Notes', 'Playbooks'])
    )

    const phases = h.progress.map((p) => p.phase)
    expect(phases[0]).toBe('preparing')
    expect(phases).toEqual(
      expect.arrayContaining(['copying', 'verifying', 'switching', 'cleaning'])
    )
    expect(phases.at(-1)).toBe('done')
    expect(h.progress.find((p) => p.phase === 'copying' && p.done === 2)?.total).toBe(2)
    expect(h.changed.at(-1)).toMatchObject({
      groupId: h.env.groupId,
      reason: 'storage',
      sectionsChanged: true
    })
    // watcher: paused, restarted on the new root, then resumed
    expect(h.watcher.calls).toEqual(['pause', `start:${h.env.groupId}`, 'resume'])
  })

  it('keeps both texts on a name collision and re-keys the moved description', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Service map.md', 'source text')
    await h.env.metaStore.updateMeta(h.env.root, (m) => {
      m.items['Notes/Service map.md'] = { description: 'from app' }
    })
    await put(h.target, 'Notes/Service map.md', 'target text')
    await put(
      h.target,
      '.arc/meta.json',
      JSON.stringify({
        version: 1,
        sections: [],
        items: { 'Notes/Service map.md': { description: 'from folder' } },
        updatedAt: 1
      })
    )

    await h.service.linkPath(h.env.groupId, h.target, 'move')

    const files = await tree(h.target)
    expect(files['Notes/Service map.md']).toBe('target text')
    expect(files['Notes/Service map (2).md']).toBe('source text')
    const meta = JSON.parse(files['.arc/meta.json'] ?? '{}') as {
      items: Record<string, { description: string }>
    }
    expect(meta.items['Notes/Service map.md']?.description).toBe('from folder')
    expect(meta.items['Notes/Service map (2).md']?.description).toBe('from app')
    expect(titles(h, h.env.notesId)).toEqual(['Service map', 'Service map (2)'])
  })

  it('compares names case-insensitively and numbers repeated collisions', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Plan.md', 'src')
    await put(h.target, 'notes/plan.md', 'one')
    await put(h.target, 'notes/plan (2).md', 'two')

    await h.service.linkPath(h.env.groupId, h.target, 'move')

    const files = await tree(h.target)
    const notesFiles = Object.keys(files).filter((f) => f.toLowerCase().startsWith('notes/'))
    expect(notesFiles.map((f) => files[f]).sort()).toEqual(['one', 'src', 'two'])
    expect(notesFiles.map((f) => (f.split('/')[1] ?? '').toLowerCase()).sort()).toEqual(
      ['plan (2).md', 'plan (3).md', 'plan.md'].sort()
    )
  })

  it('merges a custom section folder and carries empty sections along', async () => {
    const h = await setup()
    const custom = await h.env.sections.create(h.env.groupId, 'Runbooks')
    expect(custom.name).toBe('Runbooks')
    await put(h.env.root, 'Runbooks/restart.md', 'steps')

    await h.service.linkPath(h.env.groupId, h.target, 'move')

    expect((await tree(h.target))['Runbooks/restart.md']).toBe('steps')
    const sections = await h.env.sections.list(h.env.groupId)
    expect(sections.find((s) => s.name === 'Runbooks')?.itemCount).toBe(1)
  })
})

describe('KnowledgeStorageService link: rollback', () => {
  async function seed(h: Harness): Promise<void> {
    await put(h.env.root, 'Notes/A.md', 'a')
    await put(h.env.root, 'Notes/B.md', 'b')
    await put(h.env.root, 'Docs/C.md', 'c')
    await put(h.target, 'Notes/Existing.md', 'keep me')
    await put(
      h.target,
      '.arc/meta.json',
      '{"version":1,"sections":[],"items":{},"updatedAt":1,"x":"y"}\n'
    )
  }

  async function expectRolledBack(h: Harness, before: Record<string, string>): Promise<void> {
    expect(await tree(h.target)).toEqual(before)
    expect(await dirNames(h.target)).toEqual(['.arc', 'Notes'])
    const row = h.storageRepo.get(h.env.groupId)
    expect(row).toMatchObject({ mode: 'app', pendingOp: null })
    expect(await tree(h.env.root)).toMatchObject({
      'Notes/A.md': 'a',
      'Notes/B.md': 'b',
      'Docs/C.md': 'c'
    })
    expect(await exists(join(h.userData, 'groups', h.env.groupId, 'storage-op.json'))).toBe(false)
    expect(h.watcher.calls).toEqual(['pause', 'resume']) // no restart on the old root
  }

  it('mid-copy failure removes exactly the files it created', async () => {
    let calls = 0
    const h = await setup({
      fs: {
        copyFile: (s, d, m) => {
          if (++calls === 3) return Promise.reject(new Error('disk full'))
          return import('node:fs/promises').then((fs) => fs.copyFile(s, d, m))
        }
      }
    })
    await seed(h)
    const before = await tree(h.target)

    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')

    await expectRolledBack(h, before)
    expect(h.progress.map((p) => p.phase)).toContain('rolling-back')
    expect(h.changed).toEqual([]) // nothing changed, nothing announced
  })

  it('verify failure (a copy has the wrong size) rolls everything back', async () => {
    const h = await setup({
      fs: {
        stat: async (p) => {
          const info = await stat(p)
          return p.startsWith(await realpath(h.target)) && p.endsWith('A.md')
            ? { size: info.size + 1, mtimeMs: info.mtimeMs }
            : info
        }
      }
    })
    await seed(h)
    const before = await tree(h.target)

    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')

    await expectRolledBack(h, before)
  })

  it('a source file edited during the copy fails verification', async () => {
    const h = await setup({
      fs: {
        copyFile: async (s, d, m) => {
          const fs = await import('node:fs/promises')
          await fs.copyFile(s, d, m)
          if (s.endsWith('B.md')) await fs.writeFile(s, 'edited while copying')
        }
      }
    })
    await seed(h)
    const before = await tree(h.target)
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')
    expect(await tree(h.target)).toEqual(before)
    expect((await tree(h.env.root))['Notes/B.md']).toBe('edited while copying')
  })

  it('database flip failure rolls back, including the merged meta.json', async () => {
    const h = await setup({
      storageRepoWrap: (repo) => ({
        get: (id) => repo.get(id),
        beginPendingOp: (...a) => repo.beginPendingOp(...a),
        clearPendingOp: (...a) => repo.clearPendingOp(...a),
        flipStorage: () => {
          throw new Error('db locked')
        }
      })
    })
    await seed(h)
    await h.env.metaStore.updateMeta(h.env.root, (m) => {
      m.items['Notes/A.md'] = { description: 'about a' }
    })
    const before = await tree(h.target)

    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')

    await expectRolledBack(h, before)
    expect(await readFile(join(h.target, '.arc', 'meta.json'), 'utf8')).toBe(
      before['.arc/meta.json']
    )
  })

  it('rollback removes the .arc folder it created when the target had none', async () => {
    const h = await setup({
      storageRepoWrap: (repo) => ({
        get: (id) => repo.get(id),
        beginPendingOp: (...a) => repo.beginPendingOp(...a),
        clearPendingOp: (...a) => repo.clearPendingOp(...a),
        flipStorage: () => {
          throw new Error('db locked')
        }
      })
    })
    await put(h.env.root, 'Notes/A.md', 'a')
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')
    expect(await readdir(h.target)).toEqual([])
  })

  it('failure deleting the source after the flip keeps the link and the complete copy', async () => {
    const h = await setup({
      fs: {
        rm: (p, o) =>
          p.startsWith(h.env.root)
            ? Promise.reject(new Error('busy'))
            : import('node:fs/promises').then((fs) => fs.rm(p, o))
      }
    })
    await put(h.env.root, 'Notes/A.md', 'a')

    const state = await h.service.linkPath(h.env.groupId, h.target, 'move')

    expect(state.mode).toBe('linked')
    expect((await tree(h.target))['Notes/A.md']).toBe('a')
    expect(await exists(join(h.env.root, 'Notes', 'A.md'))).toBe(true) // stale leftover, tolerated
    expect(h.warn).toHaveBeenCalled()
    expect(h.storageRepo.get(h.env.groupId)?.pendingOp).toBeNull()
  })

  it('a failed rollback leaves the marker and manifest for startup recovery', async () => {
    let copies = 0
    const h = await setup({
      fs: {
        copyFile: (s, d, m) => {
          if (++copies === 2) return Promise.reject(new Error('disk full'))
          return import('node:fs/promises').then((fs) => fs.copyFile(s, d, m))
        },
        rm: (p) =>
          p.includes('/ext/target') ? Promise.reject(new Error('cannot rm')) : Promise.resolve()
      }
    })
    await put(h.env.root, 'Notes/A.md', 'a')
    await put(h.env.root, 'Notes/B.md', 'b')

    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('IO_FAILED')

    const op = h.storageRepo.get(h.env.groupId)?.pendingOp
    expect(op).not.toBeNull()
    const manifestPath = join(h.userData, 'groups', h.env.groupId, 'storage-op.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      createdFiles: string[]
    }
    expect(manifest.createdFiles.length).toBeGreaterThan(0)
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe(
      'STORAGE_OP_PENDING'
    )
  })

  it('rollbackManifest only deletes what the manifest lists', async () => {
    const root = join(tempDir(), 'r')
    await put(root, 'Notes/mine.md', 'x')
    await put(root, 'Notes/theirs.md', 'y')
    await rollbackManifest(
      { version: 1, targetRoot: root, createdFiles: ['Notes/mine.md'], createdDirs: ['Notes'] },
      undefined,
      join(root, '.arc', 'meta.json')
    )
    expect(await tree(root)).toEqual({ 'Notes/theirs.md': 'y' })
  })
})

describe('KnowledgeStorageService link: use the folder only', () => {
  it('renames knowledge to knowledge.kept and shows only the folder contents', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Mine1.md', '1')
    await put(h.env.root, 'Notes/Mine2.md', '2')
    await h.env.index.reconcileGroup(h.env.groupId)
    for (const n of ['a', 'b', 'c', 'd', 'e']) await put(h.target, `Notes/${n}.md`, n)

    const state = await h.service.linkPath(h.env.groupId, h.target, 'folder-only')

    expect(state).toMatchObject({ mode: 'linked', keptAside: true })
    const kept = join(h.userData, 'groups', h.env.groupId, 'knowledge.kept')
    expect(await tree(kept)).toMatchObject({ 'Notes/Mine1.md': '1', 'Notes/Mine2.md': '2' })
    expect(await exists(h.env.root)).toBe(false)
    expect(titles(h, h.env.notesId)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(await tree(h.target)).toMatchObject({ 'Notes/a.md': 'a' })
    expect(h.storageRepo.getKeptAside(h.env.groupId)?.keptAside).toBe(true)
    expect(h.storageRepo.get(h.env.groupId)?.pendingOp).toBeNull()
    expect(h.watcher.calls).toEqual(['pause', `start:${h.env.groupId}`, 'resume'])
  })

  it('adopts the folder subfolders as sections', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Mine.md', '1')
    await put(h.target, 'Wiki/page.md', 'p')
    await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    const sections = await h.env.sections.list(h.env.groupId)
    expect(sections.find((s) => s.name === 'Wiki')?.itemCount).toBe(1)
  })

  it('flip failure renames the knowledge folder back and removes created folders', async () => {
    const h = await setup({
      storageRepoWrap: (repo) => ({
        get: (id) => repo.get(id),
        beginPendingOp: (...a) => repo.beginPendingOp(...a),
        clearPendingOp: (...a) => repo.clearPendingOp(...a),
        flipStorage: () => {
          throw new Error('db locked')
        }
      })
    })
    await put(h.env.root, 'Notes/Mine.md', '1')
    await put(h.target, 'Notes/theirs.md', 't')

    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'folder-only'))).toBe(
      'IO_FAILED'
    )

    expect(await tree(h.env.root)).toEqual({ 'Notes/Mine.md': '1' })
    expect(await exists(join(h.userData, 'groups', h.env.groupId, 'knowledge.kept'))).toBe(false)
    expect(await tree(h.target)).toEqual({ 'Notes/theirs.md': 't' })
    expect(await dirNames(h.target)).toEqual(['Notes'])
    expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app', pendingOp: null })
  })

  it('refuses when earlier knowledge is already kept aside', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/Mine.md', '1')
    const kept = join(h.userData, 'groups', h.env.groupId, 'knowledge.kept')
    await put(kept, 'Notes/Old.md', 'old')
    h.storageRepo.setKeptAside(h.env.groupId)
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'folder-only'))).toBe(
      'STORAGE_KEPT_ASIDE_EXISTS'
    )
    expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('app')
    expect(await tree(kept)).toEqual({ 'Notes/Old.md': 'old' })
  })

  it('with no knowledge it just links and keeps nothing aside', async () => {
    const h = await setup()
    await put(h.target, 'Notes/a.md', 'a')
    const state = await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    expect(state).toMatchObject({ mode: 'linked', keptAside: false })
    expect(titles(h, h.env.notesId)).toEqual(['a'])
  })
})

describe('moveDirectory (EXDEV fallback)', () => {
  const exdev = (): Promise<void> =>
    Promise.reject(Object.assign(new Error('cross-device'), { code: 'EXDEV' }))

  it('copies, verifies and deletes the source when rename crosses volumes', async () => {
    const dir = tempDir()
    await put(join(dir, 'src'), 'Notes/a.md', 'a')
    await put(join(dir, 'src'), '.arc/meta.json', '{}')
    const fs = await import('node:fs/promises')
    await moveDirectory(join(dir, 'src'), join(dir, 'dest'), {
      copyFile: fs.copyFile,
      rename: exdev,
      rm: fs.rm,
      rmdir: fs.rmdir,
      mkdir: async (p, o) => void (await fs.mkdir(p, o)),
      stat: fs.stat
    })
    expect(await tree(join(dir, 'dest'))).toEqual({ 'Notes/a.md': 'a', '.arc/meta.json': '{}' })
    expect(await exists(join(dir, 'src'))).toBe(false)
  })

  it('a failed copy removes the partial destination and keeps the source', async () => {
    const dir = tempDir()
    await put(join(dir, 'src'), 'Notes/a.md', 'a')
    await put(join(dir, 'src'), 'Notes/b.md', 'b')
    const fs = await import('node:fs/promises')
    let copies = 0
    await expect(
      moveDirectory(join(dir, 'src'), join(dir, 'dest'), {
        copyFile: (s, d, m) =>
          ++copies === 2 ? Promise.reject(new Error('io')) : fs.copyFile(s, d, m),
        rename: exdev,
        rm: fs.rm,
        rmdir: fs.rmdir,
        mkdir: async (p, o) => void (await fs.mkdir(p, o)),
        stat: fs.stat
      })
    ).rejects.toThrow('io')
    expect(await exists(join(dir, 'dest'))).toBe(false)
    expect(await tree(join(dir, 'src'))).toEqual({ 'Notes/a.md': 'a', 'Notes/b.md': 'b' })
  })

  it('folder-only link uses the fallback when the rename is cross-device', async () => {
    const h = await setup({
      fs: {
        rename: (from, to) => (from.endsWith('knowledge') ? exdev() : rename(from, to))
      }
    })
    await put(h.env.root, 'Notes/Mine.md', '1')
    await put(h.target, 'Notes/t.md', 't')
    await h.service.linkPath(h.env.groupId, h.target, 'folder-only')
    const kept = join(h.userData, 'groups', h.env.groupId, 'knowledge.kept')
    expect(await tree(kept)).toMatchObject({ 'Notes/Mine.md': '1' })
    expect(await exists(h.env.root)).toBe(false)
    expect(titles(h, h.env.notesId)).toEqual(['t'])
  })

  it('move-merge copies with COPYFILE_EXCL so volumes never matter and nothing is overwritten', async () => {
    const modes: (number | undefined)[] = []
    const h = await setup({
      fs: {
        copyFile: async (s, d, m) => {
          modes.push(m)
          await (await import('node:fs/promises')).copyFile(s, d, m)
        }
      }
    })
    await put(h.env.root, 'Notes/a.md', 'a')
    await h.service.linkPath(h.env.groupId, h.target, 'move')
    expect(modes).toEqual([constants.COPYFILE_EXCL])
  })
})

describe('KnowledgeStorageService preflight', () => {
  async function secondGroup(h: Harness, linkedTo: string): Promise<string> {
    const groups = new GroupService({
      db: h.env.opened.db,
      groupsRepo: new GroupsRepo(h.env.opened.db),
      appDataDir: h.userData
    })
    const other = await groups.create('Other')
    h.storageRepo.flipStorage(other.id, {
      mode: 'linked',
      linkedPath: await realpath(linkedTo),
      keptAside: false
    })
    return other.id
  }

  it('rejects a folder inside app storage and one containing it', async () => {
    const h = await setup()
    const inside = join(h.env.root, 'Notes')
    await mkdir(inside, { recursive: true })
    expect((await h.service.preflight(h.env.groupId, inside)).blocked).toBe('inside-app-storage')
    expect((await h.service.preflight(h.env.groupId, h.userData)).blocked).toBe(
      'contains-app-storage'
    )
  })

  it('rejects a parent of app storage', async () => {
    const h = await setup()
    expect((await h.service.preflight(h.env.groupId, tempDir())).blocked).toBe(
      'contains-app-storage'
    )
  })

  it('rejects nesting with another group root, in both directions and when equal', async () => {
    const h = await setup()
    const otherRoot = join(tempDir(), 'ext', 'other')
    await mkdir(join(otherRoot, 'sub'), { recursive: true })
    await secondGroup(h, otherRoot)
    expect((await h.service.preflight(h.env.groupId, otherRoot)).blocked).toBe('inside-other-group')
    expect((await h.service.preflight(h.env.groupId, join(otherRoot, 'sub'))).blocked).toBe(
      'inside-other-group'
    )
    expect((await h.service.preflight(h.env.groupId, join(tempDir(), 'ext'))).blocked).toBe(
      'contains-other-group'
    )
    expect(await codeOf(h.service.linkPath(h.env.groupId, otherRoot, 'move'))).toBe(
      'STORAGE_TARGET_NESTED'
    )
    expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app', pendingOp: null })
  })

  it('rejects a file, a missing path and an unwritable folder', async () => {
    const h = await setup()
    await writeFile(join(h.target, 'f.txt'), 'x')
    expect((await h.service.preflight(h.env.groupId, join(h.target, 'f.txt'))).blocked).toBe(
      'not-a-folder'
    )
    expect((await h.service.preflight(h.env.groupId, join(h.target, 'nope'))).blocked).toBe(
      'not-a-folder'
    )
    expect(await codeOf(h.service.linkPath(h.env.groupId, join(h.target, 'nope'), 'move'))).toBe(
      'STORAGE_TARGET_INVALID'
    )
    const { chmod } = await import('node:fs/promises')
    await chmod(h.target, 0o500)
    try {
      if (process.getuid?.() !== 0) {
        expect((await h.service.preflight(h.env.groupId, h.target)).blocked).toBe('not-writable')
        expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe(
          'STORAGE_TARGET_NOT_WRITABLE'
        )
      }
    } finally {
      await chmod(h.target, 0o700)
    }
  })

  it('warns, without blocking, when the folder is inside one of the group git projects', async () => {
    const h = await setup()
    const repo = join(tempDir(), 'ext', 'repo')
    await mkdir(join(repo, 'docs', 'arc'), { recursive: true })
    const projects = new ProjectsRepo(h.env.opened.db)
    const real = await realpath(repo)
    projects.insert({
      id: 'P1',
      path: real,
      displayName: 'Shop API',
      isGit: true,
      lastSeenAt: null,
      createdAt: 1
    })
    projects.addMembership(h.env.groupId, 'P1', 0, 1)

    const pre = await h.service.preflight(h.env.groupId, join(repo, 'docs', 'arc'))
    expect(pre.blocked).toBeNull()
    expect(pre.insideProjectRepo).toEqual({ projectId: 'P1', projectName: 'Shop API' })
    expect((await h.service.preflight(h.env.groupId, repo)).insideProjectRepo).not.toBeNull()
    expect((await h.service.preflight(h.env.groupId, h.target)).insideProjectRepo).toBeNull()

    const state = await h.service.linkPath(h.env.groupId, join(repo, 'docs', 'arc'), 'move')
    expect(state.mode).toBe('linked')
  })

  it('does not warn for a non-git project, and reports knowledge and target content', async () => {
    const h = await setup()
    const dirPath = join(tempDir(), 'ext', 'plain')
    await mkdir(dirPath, { recursive: true })
    const projects = new ProjectsRepo(h.env.opened.db)
    projects.insert({
      id: 'P2',
      path: await realpath(dirPath),
      displayName: 'Plain',
      isGit: false,
      lastSeenAt: null,
      createdAt: 1
    })
    projects.addMembership(h.env.groupId, 'P2', 0, 1)
    expect((await h.service.preflight(h.env.groupId, dirPath)).insideProjectRepo).toBeNull()

    let pre = await h.service.preflight(h.env.groupId, h.target)
    expect(pre).toMatchObject({ hasKnowledge: false, targetHasContent: false })
    await put(h.env.root, 'Notes/a.md', 'a')
    await put(h.target, '.hidden/x', 'x')
    pre = await h.service.preflight(h.env.groupId, h.target)
    expect(pre).toMatchObject({ hasKnowledge: true, targetHasContent: false })
    await put(h.target, 'Notes/b.md', 'b')
    expect((await h.service.preflight(h.env.groupId, h.target)).targetHasContent).toBe(true)
  })
})

describe('KnowledgeStorageService lock, state and picking', () => {
  it('rejects a concurrent storage operation on the same group, then frees the lock', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const h = await setup({
      fs: {
        copyFile: async (s, d, m) => {
          await gate
          await (await import('node:fs/promises')).copyFile(s, d, m)
        }
      }
    })
    await put(h.env.root, 'Notes/a.md', 'a')

    const first = h.service.linkPath(h.env.groupId, h.target, 'move')
    await vi.waitFor(() => expect(h.service.isLocked(h.env.groupId)).toBe(true))
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe('STORAGE_BUSY')
    release()
    await first

    expect(h.service.isLocked(h.env.groupId)).toBe(false)
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe(
      'STORAGE_ALREADY_LINKED'
    )
  })

  it('releases the lock when the operation fails', async () => {
    const h = await setup({ fs: { copyFile: () => Promise.reject(new Error('x')) } })
    await put(h.env.root, 'Notes/a.md', 'a')
    await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))
    expect(h.service.isLocked(h.env.groupId)).toBe(false)
  })

  it('rejects when a pending operation is recorded', async () => {
    const h = await setup()
    h.storageRepo.beginPendingOp(h.env.groupId, {
      kind: 'link-move',
      sourceRoot: h.env.root,
      targetRoot: h.target,
      startedAt: 1
    })
    expect(await codeOf(h.service.linkPath(h.env.groupId, h.target, 'move'))).toBe(
      'STORAGE_OP_PENDING'
    )
  })

  it('getState reports app mode, then the linked path and availability', async () => {
    const h = await setup()
    expect(await h.service.getState(h.env.groupId)).toEqual({
      mode: 'app',
      linkedPath: null,
      keptAside: false,
      available: true,
      hasKnowledge: false
    })
    await put(h.target, 'Notes/a.md', 'a')
    await h.service.linkPath(h.env.groupId, h.target, 'move')
    const linked = await h.service.getState(h.env.groupId)
    expect(linked).toMatchObject({
      mode: 'linked',
      linkedPath: await realpath(h.target),
      available: true,
      hasKnowledge: true
    })
    await rename(h.target, `${h.target}-moved`)
    expect(await h.service.getState(h.env.groupId)).toMatchObject({
      available: false,
      hasKnowledge: false
    })
  })

  it('pickFolder returns a preflight and a single-use token bound to the group', async () => {
    const h = await setup()
    await put(h.env.root, 'Notes/a.md', 'a')
    h.picks.push([h.target])
    const picked = await h.service.pickFolder(h.env.groupId)
    expect(picked).toMatchObject({ picked: true, blocked: null, hasKnowledge: true })
    if (!picked.picked || !picked.token) throw new Error('expected a token')

    expect(await codeOf(h.service.link('someone-else', picked.token, 'move'))).toBe(
      'STORAGE_TARGET_INVALID'
    ) // consumed even by a failed attempt
    expect(await codeOf(h.service.link(h.env.groupId, picked.token, 'move'))).toBe(
      'STORAGE_TARGET_INVALID'
    )
    expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('app')

    h.picks.push([h.target])
    const again = await h.service.pickFolder(h.env.groupId)
    if (!again.picked || !again.token) throw new Error('expected a token')
    expect((await h.service.link(h.env.groupId, again.token, 'move')).mode).toBe('linked')
  })

  it('pickFolder: cancel, blocked folder (no token) and expired token', async () => {
    let now = 1000
    const h = await setup()
    expect(await h.service.pickFolder(h.env.groupId)).toEqual({ picked: false })
    h.picks.push([h.env.root])
    const blocked = await h.service.pickFolder(h.env.groupId)
    expect(blocked).toMatchObject({ picked: true, blocked: 'inside-app-storage', token: null })

    const timed = new KnowledgeStorageService({
      ...(h.service as unknown as { deps: KnowledgeStorageServiceDeps }).deps,
      now: () => now
    })
    h.picks.push([h.target])
    const ok = await timed.pickFolder(h.env.groupId)
    if (!ok.picked || !ok.token) throw new Error('expected a token')
    now += 11 * 60 * 1000
    expect(await codeOf(timed.link(h.env.groupId, ok.token, 'move'))).toBe('STORAGE_TARGET_INVALID')
  })

  it('does not touch the watcher when another group is open', async () => {
    const h = await setup()
    h.watcher.watchedGroupId = 'other'
    await put(h.env.root, 'Notes/a.md', 'a')
    await h.service.linkPath(h.env.groupId, h.target, 'move')
    expect(h.watcher.calls).toEqual([])
  })
})
