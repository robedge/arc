import { mkdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import type { KnowledgeStorageServiceDeps } from '../../../src/main/knowledge/knowledge-storage-service'
import { settleSplit } from '../../../src/main/knowledge/knowledge-storage-service'
import { recoverStorage } from '../../../src/main/knowledge/storage-recovery'
import { useTempDir } from '../helpers/temp-dir'
import { codeOf } from './knowledge-test-env'
import {
  buildService,
  crashFs,
  exists,
  fingerprint,
  put,
  setup,
  titles,
  tree
} from './storage-test-harness'
import type { StorageHarness } from './storage-test-harness'

const tempDir = useTempDir('harness-unlink-')

async function realDir(): Promise<string> {
  return realpath(tempDir())
}

/**
 * A linked group. `kept`: linked with "folder only", so the two app notes are kept aside and the
 * folder (F1, F2, F3) is all the group shows. Otherwise the app notes were merged into the folder.
 */
async function linkedGroup(
  kept: boolean
): Promise<{ h: StorageHarness; dir: string; linked: string }> {
  const dir = await realDir()
  const h = await setup(dir)
  const id = h.env.groupId
  await put(h.env.root, 'Notes/App1.md', '# App1\none')
  await put(h.env.root, 'Notes/App2.md', '# App2\ntwo')
  await h.env.index.reconcileGroup(id)
  await put(h.target, 'Notes/F1.md', '# F1\nf1')
  await put(h.target, 'Notes/F2.md', '# F2\nf2')
  await put(h.target, 'Docs/F3.md', '# F3\nf3')
  await put(
    h.target,
    '.arc/meta.json',
    JSON.stringify({
      version: 1,
      sections: [],
      items: { 'Notes/F1.md': { description: 'about f1' } },
      updatedAt: 1
    })
  )
  await put(h.target, '.git/HEAD', 'ref: refs/heads/main') // hidden entries are not knowledge
  await h.service.linkPath(id, h.target, kept ? 'folder-only' : 'move')
  expect(h.storageRepo.get(id)).toMatchObject({ mode: 'linked', keptAside: kept })
  return { h, dir, linked: await realpath(h.target) }
}

function recover(h: StorageHarness): ReturnType<typeof recoverStorage> {
  return recoverStorage({
    storageRepo: h.storageRepo,
    listGroupIds: () => new GroupsRepo(h.env.opened.db).list().map((g) => g.id),
    appDataDir: h.userData,
    log: {
      info: () => undefined,
      warn: (...a: unknown[]) => h.warn(...a),
      error: () => undefined
    }
  })
}

function flipCrash(
  onFlip: () => void
): NonNullable<Parameters<typeof buildService>[2]>['storageRepoWrap'] {
  return (repo): KnowledgeStorageServiceDeps['storageRepo'] => ({
    get: (id) => repo.get(id),
    beginPendingOp: (...a) => repo.beginPendingOp(...a),
    clearPendingOp: (...a) => repo.clearPendingOp(...a),
    flipStorage: () => {
      onFlip()
      throw new Error('simulated crash at the database flip')
    }
  })
}

async function expectNoLeftovers(h: StorageHarness): Promise<void> {
  expect(h.storageRepo.get(h.env.groupId)?.pendingOp).toBeNull()
  for (const name of ['knowledge.tmp', 'knowledge.discarded', 'storage-op.json']) {
    expect(await exists(join(h.groupDir, name))).toBe(false)
  }
}

describe('unlink: keep current knowledge', () => {
  it('copies the folder into app storage and leaves the folder byte-for-byte untouched', async () => {
    const { h, linked } = await linkedGroup(false)
    const id = h.env.groupId
    await h.env.index.reconcileGroup(id)
    const before = await fingerprint(linked)
    const notesBefore = titles(h, h.env.notesId)
    h.progress.length = 0
    h.changed.length = 0
    h.watcher.calls.length = 0

    const state = await h.service.unlink(id, 'keep-current')

    expect(state).toEqual({
      mode: 'app',
      linkedPath: null,
      keptAside: false,
      available: true,
      hasKnowledge: true
    })
    expect(await fingerprint(linked)).toEqual(before)
    const app = await tree(h.env.root)
    expect(app['Notes/F1.md']).toBe('# F1\nf1')
    expect(app['Docs/F3.md']).toBe('# F3\nf3')
    expect(app['Notes/App1.md']).toBe('# App1\none') // merged in by the earlier link
    expect(Object.keys(app).some((k) => k.startsWith('.git'))).toBe(false)
    expect(JSON.parse(app['.arc/meta.json'] ?? '{}').items['Notes/F1.md']).toEqual({
      description: 'about f1'
    })
    expect(titles(h, h.env.notesId)).toEqual(notesBefore)
    expect(
      h.env.itemsRepo.listBySection(h.env.notesId).find((r) => r.title === 'F1')
    ).toMatchObject({ description: 'about f1' })
    await expectNoLeftovers(h)
    expect(h.progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(['preparing', 'copying', 'verifying', 'switching', 'done'])
    )
    expect(h.progress.at(-1)).toMatchObject({ phase: 'done', done: 6, total: 6 })
    expect(h.changed.at(-1)).toMatchObject({ reason: 'storage', sectionsChanged: true })
    expect(h.watcher.calls).toEqual(['pause', `start:${id}`, 'resume'])
  })

  it('never issues a write, delete, rename or mkdir under the linked folder', async () => {
    const dir = await realDir()
    const cf = crashFs(null, 0)
    const env = (await linkedGroup(false)).h.env
    const h = buildService(env, dir, { fs: cf.fs })
    const linked = (await h.service.getState(env.groupId)).linkedPath as string

    await h.service.unlink(env.groupId, 'keep-current')

    const mutating = cf.log.filter((l) => !l.startsWith('copyFile:'))
    expect(mutating.length).toBeGreaterThan(0)
    expect(mutating.filter((l) => l.includes(linked))).toEqual([])
    // copyFile may only read from the linked folder: its destination is argument 2, never inside it.
    expect(cf.log.filter((l) => l.startsWith('copyFile:')).every((l) => l.includes(linked))).toBe(
      true
    )
    expect(await exists(join(linked, '.arc', 'meta.json'))).toBe(true)
  })

  it('does not rename a legacy .harness folder inside the linked folder', async () => {
    const { h, linked } = await linkedGroup(false)
    await rename(join(linked, '.arc'), join(linked, '.harness'))
    const before = await fingerprint(linked)

    await h.service.unlink(h.env.groupId, 'keep-current')

    expect(await fingerprint(linked)).toEqual(before)
    expect(await exists(join(linked, '.arc'))).toBe(false)
    expect(await exists(join(h.env.root, '.arc', 'meta.json'))).toBe(true)
  })

  it('copies empty section folders too', async () => {
    const { h, linked } = await linkedGroup(false)
    await mkdir(join(linked, 'Scratch'))
    await h.service.unlink(h.env.groupId, 'keep-current')
    expect(await exists(join(h.env.root, 'Scratch'))).toBe(true)
  })

  it('stages in a clean knowledge.tmp and replaces stale app leftovers instead of merging', async () => {
    const { h, linked } = await linkedGroup(false)
    await put(h.env.root, 'Notes/Stale.md', 'left behind by a failed source delete')
    await put(h.userData, `groups/${h.env.groupId}/knowledge.tmp/Junk.md`, 'old staging')

    await h.service.unlink(h.env.groupId, 'keep-current')

    const app = await tree(h.env.root)
    expect(app['Notes/Stale.md']).toBeUndefined()
    expect(app['Junk.md']).toBeUndefined()
    expect(
      Object.keys(app)
        .filter((k) => !k.startsWith('.arc'))
        .sort()
    ).toEqual(
      Object.keys(await tree(linked))
        .filter((k) => !k.startsWith('.'))
        .sort()
    )
    expect(titles(h, h.env.notesId)).not.toContain('Stale')
    await expectNoLeftovers(h)
  })

  it('discards kept-aside knowledge only after the flip, and leaves no kept folder or flag', async () => {
    const { h } = await linkedGroup(true)
    expect(await exists(join(h.groupDir, 'knowledge.kept', 'Notes', 'App1.md'))).toBe(true)

    const state = await h.service.unlink(h.env.groupId, 'keep-current')

    expect(state).toMatchObject({ mode: 'app', keptAside: false })
    expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(false)
    expect(titles(h, h.env.notesId)).toEqual(['F1', 'F2'])
    await expectNoLeftovers(h)
  })

  it('a failure before the flip keeps the group linked and the kept-aside knowledge', async () => {
    const { h, dir, linked } = await linkedGroup(true)
    const before = await fingerprint(linked)
    const failing = buildService(h.env, dir, {
      storageRepoWrap: (repo) => ({
        get: (id) => repo.get(id),
        beginPendingOp: (...a) => repo.beginPendingOp(...a),
        clearPendingOp: (...a) => repo.clearPendingOp(...a),
        flipStorage: () => {
          throw new Error('db locked')
        }
      })
    })

    expect(await codeOf(failing.service.unlink(h.env.groupId, 'keep-current'))).toBe('IO_FAILED')

    expect(h.storageRepo.get(h.env.groupId)).toMatchObject({
      mode: 'linked',
      keptAside: true,
      pendingOp: null
    })
    expect(await tree(join(h.groupDir, 'knowledge.kept'))).toMatchObject({
      'Notes/App1.md': '# App1\none'
    })
    expect(await exists(join(h.groupDir, 'knowledge'))).toBe(false)
    await expectNoLeftovers(h)
    expect(await fingerprint(linked)).toEqual(before)
    expect(failing.watcher.calls).toEqual(['pause', 'resume'])
    // and the same unlink works afterwards
    expect((await h.service.unlink(h.env.groupId, 'keep-current')).mode).toBe('app')
  })

  it('a mid-copy failure removes the staging folder', async () => {
    const { h, dir } = await linkedGroup(false)
    let copies = 0
    const failing = buildService(h.env, dir, {
      fs: {
        copyFile: (s, d, m) => {
          if (++copies === 2) return Promise.reject(new Error('disk full'))
          return import('node:fs/promises').then((fs) => fs.copyFile(s, d, m))
        }
      }
    })
    expect(await codeOf(failing.service.unlink(h.env.groupId, 'keep-current'))).toBe('IO_FAILED')
    await expectNoLeftovers(h)
    expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('linked')
  })
})

describe('unlink: restore kept-aside knowledge', () => {
  it('renames knowledge.kept back and never touches the folder', async () => {
    const { h, linked } = await linkedGroup(true)
    const before = await fingerprint(linked)
    h.watcher.calls.length = 0

    const state = await h.service.unlink(h.env.groupId, 'restore-kept')

    expect(state).toMatchObject({ mode: 'app', linkedPath: null, keptAside: false })
    expect(await fingerprint(linked)).toEqual(before)
    expect(titles(h, h.env.notesId)).toEqual(['App1', 'App2'])
    expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(false)
    expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ keptAside: false, keptAsideAt: null })
    await expectNoLeftovers(h)
    expect(h.watcher.calls).toEqual(['pause', `start:${h.env.groupId}`, 'resume'])
  })

  it('works while the linked folder is missing (it is never read)', async () => {
    const { h, linked } = await linkedGroup(true)
    await rename(linked, `${linked}-gone`)
    const state = await h.service.unlink(h.env.groupId, 'restore-kept')
    expect(state).toMatchObject({ mode: 'app' })
    expect(titles(h, h.env.notesId)).toEqual(['App1', 'App2'])
    expect(await exists(linked)).toBe(false)
  })

  it('removes a stale app knowledge folder instead of merging it', async () => {
    const { h } = await linkedGroup(true)
    await put(h.env.root, 'Notes/Stale.md', 'stale')
    await h.service.unlink(h.env.groupId, 'restore-kept')
    const app = await tree(h.env.root)
    expect(app['Notes/Stale.md']).toBeUndefined()
    expect(app['Notes/App1.md']).toBe('# App1\none')
  })
})

describe('unlink: errors', () => {
  it('rejects app mode, nothing kept aside, a missing folder and a pending operation', async () => {
    const appDir = join(await realDir(), 'app-only')
    await mkdir(appDir)
    const app = await setup(appDir)
    expect(await codeOf(app.service.unlink(app.env.groupId, 'keep-current'))).toBe(
      'STORAGE_NOT_LINKED'
    )

    const { h, linked } = await linkedGroup(false)
    expect(await codeOf(h.service.unlink(h.env.groupId, 'restore-kept'))).toBe(
      'STORAGE_NO_KEPT_ASIDE'
    )
    h.storageRepo.beginPendingOp(h.env.groupId, {
      kind: 'unlink-restore',
      sourceRoot: 'a',
      targetRoot: 'b',
      startedAt: 1
    })
    expect(await codeOf(h.service.unlink(h.env.groupId, 'keep-current'))).toBe('STORAGE_OP_PENDING')
    h.storageRepo.clearPendingOp(h.env.groupId)

    await rename(linked, `${linked}-gone`)
    expect(await codeOf(h.service.unlink(h.env.groupId, 'keep-current'))).toBe(
      'KNOWLEDGE_ROOT_MISSING'
    )
    expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('linked')
  })
})

describe('locate', () => {
  it('relinks to the moved folder, keeps the index ids and kept-aside knowledge', async () => {
    const { h, dir, linked } = await linkedGroup(true)
    const id = h.env.groupId
    await h.env.index.reconcileGroup(id)
    const idsBefore = h.env.itemsRepo
      .listBySection(h.env.notesId)
      .map((r) => r.id)
      .sort()
    const moved = join(dir, 'ext', 'renamed')
    await rename(linked, moved)
    expect(await h.service.getState(id)).toMatchObject({ available: false, hasKnowledge: false })
    h.picks.push([moved])
    h.watcher.calls.length = 0
    h.changed.length = 0

    const result = await h.service.locate(id)

    expect(result).toMatchObject({
      located: true,
      looksLikeKnowledge: true,
      state: { mode: 'linked', linkedPath: await realpath(moved), available: true, keptAside: true }
    })
    expect(
      h.env.itemsRepo
        .listBySection(h.env.notesId)
        .map((r) => r.id)
        .sort()
    ).toEqual(idsBefore)
    expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(true)
    expect(h.watcher.calls).toEqual(['pause', `start:${id}`, 'resume'])
    expect(h.changed.at(-1)).toMatchObject({ reason: 'storage' })
    expect(h.storageRepo.get(id)?.pendingOp).toBeNull()
  })

  it('advisory check: an unrelated empty folder is accepted but not flagged', async () => {
    const { h, dir, linked } = await linkedGroup(false)
    await rename(linked, `${linked}-gone`)
    const empty = join(dir, 'ext', 'empty')
    await mkdir(empty)
    h.picks.push([empty])
    const result = await h.service.locate(h.env.groupId)
    expect(result).toMatchObject({ located: true, looksLikeKnowledge: false })
  })

  it('a folder with a section-named subfolder looks right even without .arc', async () => {
    const { h, dir, linked } = await linkedGroup(false)
    await rename(linked, `${linked}-gone`)
    const other = join(dir, 'ext', 'other')
    await put(other, 'Notes/x.md', 'x')
    h.picks.push([other])
    expect(await h.service.locate(h.env.groupId)).toMatchObject({ looksLikeKnowledge: true })
  })

  it('cancel changes nothing; blocked folders throw; app mode is rejected', async () => {
    const { h, dir, linked } = await linkedGroup(false)
    expect(await h.service.locate(h.env.groupId)).toEqual({ located: false })
    h.picks.push([join(h.userData, 'groups')])
    expect(await codeOf(h.service.locate(h.env.groupId))).toBe('STORAGE_TARGET_NESTED')
    h.picks.push([join(dir, 'nope')])
    expect(await codeOf(h.service.locate(h.env.groupId))).toBe('STORAGE_TARGET_INVALID')
    expect((await h.service.getState(h.env.groupId)).linkedPath).toBe(linked)

    const appOnly = await setup(
      await realDir()
        .then((d) => join(d, 'x'))
        .then(async (d) => {
          await mkdir(d, { recursive: true })
          return d
        })
    )
    expect(await codeOf(appOnly.service.locate(appOnly.env.groupId))).toBe('STORAGE_NOT_LINKED')
  })
})

describe('useAppStorage', () => {
  it('refuses while the folder is available', async () => {
    const { h } = await linkedGroup(false)
    expect(await codeOf(h.service.useAppStorage(h.env.groupId))).toBe('STORAGE_ROOT_AVAILABLE')
  })

  it('without kept-aside knowledge starts empty, with section folders, and never touches the missing path', async () => {
    const { h, linked } = await linkedGroup(false)
    await h.env.index.reconcileGroup(h.env.groupId)
    expect(titles(h, h.env.notesId).length).toBeGreaterThan(0)
    await rename(linked, `${linked}-gone`)
    await put(h.env.root, 'Notes/Stale.md', 'stale')

    const state = await h.service.useAppStorage(h.env.groupId)

    expect(state).toEqual({
      mode: 'app',
      linkedPath: null,
      keptAside: false,
      available: true,
      hasKnowledge: false
    })
    expect(await exists(linked)).toBe(false)
    expect(await tree(h.env.root)).toEqual({})
    expect(await exists(join(h.env.root, 'Notes'))).toBe(true)
    expect(titles(h, h.env.notesId)).toEqual([])
    expect(h.changed.at(-1)).toMatchObject({ reason: 'storage' })
    await expectNoLeftovers(h)
  })

  it('with kept-aside knowledge restores it', async () => {
    const { h, linked } = await linkedGroup(true)
    await rename(linked, `${linked}-gone`)
    const state = await h.service.useAppStorage(h.env.groupId)
    expect(state).toMatchObject({ mode: 'app', keptAside: false, hasKnowledge: true })
    expect(titles(h, h.env.notesId)).toEqual(['App1', 'App2'])
    expect(await exists(linked)).toBe(false)
    await expectNoLeftovers(h)
  })
})

describe('index: a missing linked root', () => {
  it('does not empty the index', async () => {
    const { h, linked } = await linkedGroup(false)
    await h.env.index.reconcileGroup(h.env.groupId)
    const before = titles(h, h.env.notesId)
    expect(before.length).toBeGreaterThan(0)
    await rename(linked, `${linked}-gone`)
    await h.env.index.reconcileGroup(h.env.groupId)
    expect(titles(h, h.env.notesId)).toEqual(before)
  })
})

describe('startup recovery: simulated crashes', () => {
  /** Runs `act` on a service whose fs dies at the given point, expects it to fail with the marker left. */
  async function crashDuring(
    h: StorageHarness,
    dir: string,
    cf: ReturnType<typeof crashFs>,
    act: (s: StorageHarness) => Promise<unknown>,
    flipDies = false
  ): Promise<void> {
    const crashed = buildService(h.env, dir, {
      fs: cf.fs,
      ...(flipDies ? { storageRepoWrap: flipCrash(() => cf.kill()) } : {})
    })
    expect(await codeOf(act(crashed))).toBe('IO_FAILED')
    expect(h.storageRepo.get(h.env.groupId)?.pendingOp).not.toBeNull()
  }

  describe('link-move', () => {
    async function fixture(): Promise<{ h: StorageHarness; dir: string; before: string[] }> {
      const dir = await realDir()
      const h = await setup(dir)
      await put(h.env.root, 'Notes/A.md', 'a')
      await put(h.env.root, 'Notes/B.md', 'b')
      await put(h.env.root, 'Docs/C.md', 'c')
      await put(h.target, 'Notes/Existing.md', 'keep me')
      return { h, dir, before: await fingerprint(h.target) }
    }

    it('crash mid-copy: created files are removed, the source stays', async () => {
      const { h, dir, before } = await fixture()
      await crashDuring(h, dir, crashFs('copyFile', 3), (s) =>
        s.service.linkPath(h.env.groupId, h.target, 'move')
      )
      expect((await fingerprint(h.target)).length).toBeGreaterThan(before.length)

      const actions = await recover(h)

      expect(actions).toMatchObject([{ kind: 'link-move', outcome: 'rolled-back' }])
      expect((await fingerprint(h.target)).filter((l) => !l.startsWith('d '))).toEqual(
        before.filter((l) => !l.startsWith('d '))
      )
      expect(await tree(h.env.root)).toEqual({
        'Notes/A.md': 'a',
        'Notes/B.md': 'b',
        'Docs/C.md': 'c'
      })
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app' })
      await expectNoLeftovers(h)
    })

    it('crash at the database flip: everything copied is rolled back', async () => {
      const { h, dir, before } = await fixture()
      await crashDuring(
        h,
        dir,
        crashFs(null, 0),
        (s) => s.service.linkPath(h.env.groupId, h.target, 'move'),
        true
      )
      expect(Object.keys(await tree(h.target)).length).toBeGreaterThan(1)

      await recover(h)

      expect((await fingerprint(h.target)).filter((l) => !l.startsWith('d '))).toEqual(
        before.filter((l) => !l.startsWith('d '))
      )
      expect(Object.keys(await tree(h.env.root)).sort()).toEqual([
        'Docs/C.md',
        'Notes/A.md',
        'Notes/B.md'
      ])
      expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('app')
      await expectNoLeftovers(h)
    })
  })

  describe('link-folder-only', () => {
    async function fixture(): Promise<{ h: StorageHarness; dir: string }> {
      const dir = await realDir()
      const h = await setup(dir)
      await put(h.env.root, 'Notes/A.md', 'a')
      await put(h.target, 'Notes/F.md', 'f')
      return { h, dir }
    }

    it('marker set but nothing moved yet: just clears the marker', async () => {
      const { h } = await fixture()
      h.storageRepo.beginPendingOp(h.env.groupId, {
        kind: 'link-folder-only',
        sourceRoot: h.env.root,
        targetRoot: h.target,
        startedAt: 1
      })
      await recover(h)
      expect(await tree(h.env.root)).toEqual({ 'Notes/A.md': 'a' })
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app', keptAside: false })
      await expectNoLeftovers(h)
    })

    it('crash at the flip after the rename: knowledge.kept goes back to knowledge', async () => {
      const { h, dir } = await fixture()
      await crashDuring(
        h,
        dir,
        crashFs(null, 0),
        (s) => s.service.linkPath(h.env.groupId, h.target, 'folder-only'),
        true
      )
      expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(true)
      expect(await exists(h.env.root)).toBe(false)

      await recover(h)

      expect(await tree(h.env.root)).toEqual({ 'Notes/A.md': 'a' })
      expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(false)
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app', keptAside: false })
      await expectNoLeftovers(h)
      // the group can be linked again
      const again = await buildService(h.env, dir).service.linkPath(
        h.env.groupId,
        h.target,
        'folder-only'
      )
      expect(again.mode).toBe('linked')
    })
  })

  describe('unlink-copy-back', () => {
    it('crash while staging: knowledge.tmp is removed, group stays linked, folder untouched', async () => {
      const { h, dir, linked } = await linkedGroup(false)
      const before = await fingerprint(linked)
      await crashDuring(h, dir, crashFs('copyFile', 2), (s) =>
        s.service.unlink(h.env.groupId, 'keep-current')
      )
      expect(await exists(join(h.groupDir, 'knowledge.tmp'))).toBe(true)

      const actions = await recover(h)

      expect(actions).toMatchObject([{ kind: 'unlink-copy-back', outcome: 'rolled-back' }])
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'linked' })
      expect(await fingerprint(linked)).toEqual(before)
      await expectNoLeftovers(h)
    })

    it('crash after the swap but before the flip: the unused copy is removed', async () => {
      const { h, dir, linked } = await linkedGroup(false)
      const before = await fingerprint(linked)
      await crashDuring(
        h,
        dir,
        crashFs(null, 0),
        (s) => s.service.unlink(h.env.groupId, 'keep-current'),
        true
      )
      expect(await exists(join(h.groupDir, 'knowledge', 'Notes', 'F1.md'))).toBe(true)
      expect(h.storageRepo.get(h.env.groupId)?.mode).toBe('linked')

      await recover(h)

      expect(await exists(join(h.groupDir, 'knowledge'))).toBe(false)
      expect(await fingerprint(linked)).toEqual(before)
      await expectNoLeftovers(h)
      // a retry after recovery succeeds
      expect(
        (await buildService(h.env, dir).service.unlink(h.env.groupId, 'keep-current')).mode
      ).toBe('app')
    })

    it('with kept-aside knowledge, crash after moving it to knowledge.discarded: it is put back', async () => {
      const { h, dir, linked } = await linkedGroup(true)
      const before = await fingerprint(linked)
      const keptBefore = await tree(join(h.groupDir, 'knowledge.kept'))
      // rename #1 = kept -> discarded, rename #2 = tmp -> knowledge
      await crashDuring(h, dir, crashFs('rename', 2), (s) =>
        s.service.unlink(h.env.groupId, 'keep-current')
      )
      expect(await exists(join(h.groupDir, 'knowledge.discarded'))).toBe(true)
      expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(false)

      await recover(h)

      expect(await tree(join(h.groupDir, 'knowledge.kept'))).toEqual(keptBefore)
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'linked', keptAside: true })
      expect(await fingerprint(linked)).toEqual(before)
      await expectNoLeftovers(h)
      expect(
        (await buildService(h.env, dir).service.unlink(h.env.groupId, 'restore-kept')).mode
      ).toBe('app')
    })

    it('with kept-aside knowledge, crash at the flip: kept-aside knowledge survives', async () => {
      const { h, dir } = await linkedGroup(true)
      const keptBefore = await tree(join(h.groupDir, 'knowledge.kept'))
      await crashDuring(
        h,
        dir,
        crashFs(null, 0),
        (s) => s.service.unlink(h.env.groupId, 'keep-current'),
        true
      )
      await recover(h)
      expect(await tree(join(h.groupDir, 'knowledge.kept'))).toEqual(keptBefore)
      expect(await exists(join(h.groupDir, 'knowledge'))).toBe(false)
      await expectNoLeftovers(h)
    })

    it('crash after the flip while discarding: the next start finishes the discard', async () => {
      const { h, dir } = await linkedGroup(true)
      const crashed = buildService(h.env, dir, {
        fs: {
          rm: (p, o) =>
            p.endsWith('knowledge.discarded')
              ? Promise.reject(new Error('simulated crash'))
              : import('node:fs/promises').then((fs) => fs.rm(p, o))
        }
      })
      await crashed.service.unlink(h.env.groupId, 'keep-current') // succeeds; the discard only warns
      expect(crashed.warn).toHaveBeenCalled()
      expect(await exists(join(h.groupDir, 'knowledge.discarded'))).toBe(true)
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'app', keptAside: false })

      const actions = await recover(h)

      expect(actions).toMatchObject([{ kind: 'sweep', outcome: 'cleaned' }])
      await expectNoLeftovers(h)
      expect(titles(h, h.env.notesId)).toEqual(['F1', 'F2'])
    })
  })

  describe('unlink-restore', () => {
    it('a failing rename rolls back in process and leaves kept-aside knowledge untouched', async () => {
      const { h, dir } = await linkedGroup(true)
      const keptBefore = await tree(join(h.groupDir, 'knowledge.kept'))
      let renames = 0
      const failing = buildService(h.env, dir, {
        fs: {
          rename: (a, b) =>
            ++renames === 1
              ? Promise.reject(new Error('EBUSY'))
              : import('node:fs/promises').then((fs) => fs.rename(a, b))
        }
      })
      expect(await codeOf(failing.service.unlink(h.env.groupId, 'restore-kept'))).toBe('IO_FAILED')
      expect(await tree(join(h.groupDir, 'knowledge.kept'))).toEqual(keptBefore)
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'linked', keptAside: true })
      await expectNoLeftovers(h)
    })

    it('crash at the flip after the rename: the tree goes back to knowledge.kept', async () => {
      const { h, dir } = await linkedGroup(true)
      const keptBefore = await tree(join(h.groupDir, 'knowledge.kept'))
      await crashDuring(
        h,
        dir,
        crashFs(null, 0),
        (s) => s.service.unlink(h.env.groupId, 'restore-kept'),
        true
      )
      expect(await exists(join(h.groupDir, 'knowledge.kept'))).toBe(false)

      await recover(h)

      expect(await tree(join(h.groupDir, 'knowledge.kept'))).toEqual(keptBefore)
      expect(await exists(join(h.groupDir, 'knowledge'))).toBe(false)
      expect(h.storageRepo.get(h.env.groupId)).toMatchObject({ mode: 'linked', keptAside: true })
      await expectNoLeftovers(h)
      expect(
        (await buildService(h.env, dir).service.unlink(h.env.groupId, 'restore-kept')).mode
      ).toBe('app')
    })
  })

  describe('corrupt marker and sweep', () => {
    it('a corrupt marker in app mode with knowledge.kept and no knowledge moves it back', async () => {
      const { h } = await linkedGroup(true)
      await h.service.unlink(h.env.groupId, 'restore-kept')
      // fabricate a half-finished folder-only link: kept present, knowledge missing, junk marker
      await rename(h.env.root, join(h.groupDir, 'knowledge.kept'))
      h.storageRepo.update(h.env.groupId, { pendingOp: '{not json', updatedAt: 1 })
      expect(h.storageRepo.listPendingOps()).toMatchObject([{ op: null }])

      const actions = await recover(h)

      expect(actions).toMatchObject([{ kind: 'corrupt', outcome: 'rolled-back' }])
      expect(titles(h, h.env.notesId)).toEqual(['App1', 'App2'])
      expect(await exists(join(h.env.root, 'Notes', 'App1.md'))).toBe(true)
      await expectNoLeftovers(h)
    })

    it('a corrupt marker with no recognisable state just clears it', async () => {
      const dir = await realDir()
      const h = await setup(dir)
      h.storageRepo.update(h.env.groupId, { pendingOp: 'garbage', updatedAt: 1 })
      await recover(h)
      expect(h.storageRepo.get(h.env.groupId)?.pendingOp).toBeNull()
    })

    it('removes stray staging with no marker, flags a missing kept folder, keeps an orphan kept folder', async () => {
      const dir = await realDir()
      const h = await setup(dir)
      await put(h.groupDir, 'knowledge.tmp/x.md', 'x')
      await put(h.groupDir, 'storage-op.json', '{}')
      h.storageRepo.setKeptAside(h.env.groupId) // flag set, folder missing

      await recover(h)

      expect(await exists(join(h.groupDir, 'knowledge.tmp'))).toBe(false)
      expect(await exists(join(h.groupDir, 'storage-op.json'))).toBe(false)
      expect(h.storageRepo.get(h.env.groupId)?.keptAside).toBe(false)

      await put(h.groupDir, 'knowledge.kept/Notes/keep.md', 'keep')
      await recover(h)
      expect(await exists(join(h.groupDir, 'knowledge.kept', 'Notes', 'keep.md'))).toBe(true)
      expect(h.warn).toHaveBeenCalled()
    })

    it('a group that cannot be repaired keeps its marker and is reported as failed', async () => {
      const { h } = await linkedGroup(true)
      h.storageRepo.beginPendingOp(h.env.groupId, {
        kind: 'unlink-restore',
        sourceRoot: 'a',
        targetRoot: 'b',
        startedAt: 1
      })
      const actions = await recoverStorage({
        storageRepo: h.storageRepo,
        listGroupIds: () => [h.env.groupId],
        appDataDir: h.userData,
        log: { info: () => undefined, warn: () => undefined, error: () => undefined },
        fs: { rm: () => Promise.reject(new Error('EIO')) }
      })
      expect(actions).toMatchObject([{ kind: 'unlink-restore', outcome: 'failed' }])
      expect(h.storageRepo.get(h.env.groupId)?.pendingOp).not.toBeNull()
      expect(await codeOf(h.service.unlink(h.env.groupId, 'restore-kept'))).toBe(
        'STORAGE_OP_PENDING'
      )
    })
  })
})

describe('settleSplit', () => {
  it('moves a lone tree, keeps the fuller tree when both exist, reports lost when neither does', async () => {
    const dir = await realDir()
    await put(dir, 'a/1.md', '1')
    expect(await settleSplit(join(dir, 'final'), join(dir, 'a'))).toBe('ok')
    expect(await tree(join(dir, 'final'))).toEqual({ '1.md': '1' })

    await put(dir, 'other/1.md', '1')
    await put(dir, 'other/2.md', '2')
    expect(await settleSplit(join(dir, 'final'), join(dir, 'other'))).toBe('ok')
    expect(await tree(join(dir, 'final'))).toEqual({ '1.md': '1', '2.md': '2' })
    expect(await exists(join(dir, 'other'))).toBe(false)

    await put(dir, 'partial/1.md', '1')
    expect(await settleSplit(join(dir, 'final'), join(dir, 'partial'))).toBe('ok')
    expect(await tree(join(dir, 'final'))).toEqual({ '1.md': '1', '2.md': '2' })

    expect(await settleSplit(join(dir, 'x'), join(dir, 'y'))).toBe('lost')
  })
})
