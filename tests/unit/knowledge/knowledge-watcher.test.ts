import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EchoSuppressor,
  KnowledgeWatcher,
  countWatchedFiles,
  isIgnoredRelPath
} from '../../../src/main/knowledge/knowledge-watcher'
import type {
  KnowledgeWatcherDeps,
  WatcherHandle
} from '../../../src/main/knowledge/knowledge-watcher'
import { AvailabilityService } from '../../../src/main/knowledge/availability-service'
import { atomicWriteFile } from '../../../src/main/knowledge/atomic-write'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import { useTempDir } from '../helpers/temp-dir'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

type Changed = IpcEvents['knowledge:changed']

describe('isIgnoredRelPath', () => {
  it('ignores temp files, .DS_Store and dot-folders but keeps .arc', () => {
    expect(isIgnoredRelPath('Notes/.DS_Store')).toBe(true)
    expect(isIgnoredRelPath('Notes/.tmp-abc-note.md')).toBe(true)
    expect(isIgnoredRelPath('Notes/note.md~')).toBe(true)
    expect(isIgnoredRelPath('Notes/note.md.swp')).toBe(true)
    expect(isIgnoredRelPath('.git/HEAD')).toBe(true)
    expect(isIgnoredRelPath('.harness/meta.json')).toBe(true)
    expect(isIgnoredRelPath('.arc/.tmp-1-meta.json')).toBe(true)
    expect(isIgnoredRelPath('')).toBe(false)
    expect(isIgnoredRelPath('Notes')).toBe(false)
    expect(isIgnoredRelPath('Notes/note.md')).toBe(false)
    expect(isIgnoredRelPath('.arc/meta.json')).toBe(false)
  })
})

describe('EchoSuppressor', () => {
  it('drops an event matching the recorded mtime and size, until the ttl lapses', () => {
    let now = 1000
    const echo = new EchoSuppressor(500, () => now)
    echo.record('/r/a.md', { mtimeMs: 10, size: 4 })
    expect(echo.isEcho('/r/a.md', { mtimeMs: 10, size: 4 })).toBe(true)
    expect(echo.isEcho('/r/a.md', { mtimeMs: 10, size: 4 })).toBe(true) // add + change both drop
    now = 1501
    expect(echo.isEcho('/r/a.md', { mtimeMs: 10, size: 4 })).toBe(false)
  })

  it('does not treat a later outside edit, a deletion or another path as an echo', () => {
    const echo = new EchoSuppressor(500, () => 0)
    echo.record('/r/a.md', { mtimeMs: 10, size: 4 })
    expect(echo.isEcho('/r/a.md', { mtimeMs: 11, size: 4 })).toBe(false)
    expect(echo.isEcho('/r/a.md', { mtimeMs: 10, size: 9 })).toBe(false)
    expect(echo.isEcho('/r/a.md', null)).toBe(false)
    expect(echo.isEcho('/r/b.md', { mtimeMs: 10, size: 4 })).toBe(false)
  })
})

describe('KnowledgeWatcher (fake watcher, fake timers)', () => {
  const dir = useTempDir()
  let env: KnowledgeEnv
  let emitted: Changed[]
  let listener: ((event: string, path: string) => void) | undefined
  let closed: number
  let watcher: KnowledgeWatcher

  function make(overrides: Partial<KnowledgeWatcherDeps> = {}): KnowledgeWatcher {
    return new KnowledgeWatcher({
      getKnowledgeRoot: () => env.root,
      index: env.index,
      sectionsRepo: env.sectionsRepo,
      itemsRepo: env.itemsRepo,
      adoptFolders: (groupId) => env.sections.adoptFolders(groupId),
      emit: (_event, payload) => emitted.push(payload),
      watch: () => {
        const handle: WatcherHandle = {
          on(event: string, fn: never) {
            if (event === 'all') listener = fn
            return handle
          },
          close: () => {
            closed++
            return Promise.resolve()
          }
        }
        return handle
      },
      ...overrides
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    env = await createEnv(dir())
    emitted = []
    listener = undefined
    closed = 0
    watcher = make()
    await watcher.start(env.groupId)
  })
  afterEach(async () => {
    await watcher.dispose()
    vi.useRealTimers()
    env.opened.sqlite.close()
  })

  async function settle(ms = 300): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms)
    await watcher.idle()
  }

  it('coalesces a burst of events into one reconcile and one emit', async () => {
    const reconcile = vi.spyOn(env.index, 'reconcileSection')
    await writeFile(join(env.root, 'Notes', 'a.md'), 'a')
    await writeFile(join(env.root, 'Notes', 'b.md'), 'b')
    for (const f of ['a.md', 'b.md', 'a.md']) listener?.('add', join(env.root, 'Notes', f))
    await settle(299)
    expect(emitted).toHaveLength(0)
    await settle(1)
    expect(emitted).toHaveLength(1)
    expect(reconcile).toHaveBeenCalledTimes(1)
    const payload = emitted[0]
    expect(payload).toMatchObject({
      groupId: env.groupId,
      sectionIds: [env.notesId],
      reason: 'external'
    })
    expect(payload?.items?.map((i) => i.revision !== null)).toEqual([true, true])
  })

  it('restarts the window while events keep arriving', async () => {
    await writeFile(join(env.root, 'Notes', 'a.md'), 'a')
    listener?.('add', join(env.root, 'Notes', 'a.md'))
    await settle(200)
    listener?.('change', join(env.root, 'Notes', 'a.md'))
    await settle(200)
    expect(emitted).toHaveLength(0)
    await settle(100)
    expect(emitted).toHaveLength(1)
  })

  it('reports an edited item with its new revision and a deleted item with null', async () => {
    const item = await env.service.create(env.notesId, 'Plan')
    const file = join(env.root, 'Notes', 'Plan.md')
    await writeFile(file, 'edited outside')
    listener?.('change', file)
    await settle()
    expect(emitted[0]?.items).toEqual([
      expect.objectContaining({ id: item.id, sectionId: env.notesId })
    ])
    expect(emitted[0]?.items?.[0]?.revision).not.toBe(item.revision)
    await rm(file)
    listener?.('unlink', file)
    await settle()
    expect(emitted[1]?.items).toEqual([{ id: item.id, sectionId: env.notesId, revision: null }])
  })

  it("drops the app's own atomic writes but not a later outside edit", async () => {
    const file = join(env.root, 'Notes', 'own.md')
    await atomicWriteFile(file, 'mine')
    listener?.('add', file)
    await settle()
    expect(emitted).toHaveLength(0)

    await writeFile(file, 'someone else, longer')
    listener?.('change', file)
    await settle()
    expect(emitted).toHaveLength(1)
  })

  it('adopts a new top-level folder as a section and flags sectionsChanged', async () => {
    await mkdir(join(env.root, 'Runbooks'))
    await writeFile(join(env.root, 'Runbooks', 'deploy.md'), 'steps')
    listener?.('addDir', join(env.root, 'Runbooks'))
    await settle()
    const payload = emitted[0]
    expect(payload?.sectionsChanged).toBe(true)
    expect(payload?.sectionIds).toHaveLength(1)
    expect(payload?.items).toHaveLength(1)
    expect((await env.sections.list(env.groupId)).some((s) => s.name === 'Runbooks')).toBe(true)
  })

  it('does not emit when the reconcile finds nothing new', async () => {
    listener?.('change', join(env.root, 'Notes', 'ghost.md'))
    await settle()
    expect(emitted).toHaveLength(0)
  })

  it('pause drops events, resume rescans and reports what changed meanwhile', async () => {
    watcher.pause()
    await writeFile(join(env.root, 'Notes', 'bulk.md'), 'x')
    listener?.('add', join(env.root, 'Notes', 'bulk.md'))
    await settle()
    expect(emitted).toHaveLength(0)
    await watcher.resume()
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.sectionIds).toEqual([env.notesId])
  })

  it('rescan finds changes that produced no events (focus)', async () => {
    await writeFile(join(env.root, 'Docs', 'missed.md'), 'x')
    await watcher.rescan()
    expect(emitted).toHaveLength(1)
    await watcher.rescan()
    expect(emitted).toHaveLength(1)
  })

  it('stop closes the handle, cancels the pending flush, and later events are ignored', async () => {
    await writeFile(join(env.root, 'Notes', 'late.md'), 'x')
    listener?.('add', join(env.root, 'Notes', 'late.md'))
    await watcher.stop()
    await settle()
    expect(closed).toBe(1)
    expect(emitted).toHaveLength(0)
    listener?.('add', join(env.root, 'Notes', 'late.md'))
    await settle()
    expect(emitted).toHaveLength(0)
    expect(watcher.watchedGroupId).toBeNull()
  })

  it('stopFor only stops the watched group', async () => {
    await watcher.stopFor('someone-else')
    expect(watcher.watchedGroupId).toBe(env.groupId)
    await watcher.stopFor(env.groupId)
    expect(watcher.watchedGroupId).toBeNull()
  })

  it('warns and does not watch when the root has more files than the cap', async () => {
    await watcher.stop()
    const warn = vi.fn()
    const spy = vi.fn()
    const capped = make({
      fileCap: 2,
      countFiles: () => Promise.resolve(3),
      log: { warn },
      watch: spy
    })
    await capped.start(env.groupId)
    expect(spy).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('more than 2 files'))
    // Degraded mode still rescans on focus.
    await writeFile(join(env.root, 'Notes', 'z.md'), 'x')
    await capped.rescan()
    expect(emitted).toHaveLength(1)
    await capped.dispose()
  })

  describe('polling fallback above the cap', () => {
    async function overCap(): Promise<KnowledgeWatcher> {
      await watcher.stop()
      const spy = vi.fn()
      const polled = make({
        fileCap: 2,
        pollMs: 5000,
        countFiles: () => Promise.resolve(3),
        watch: spy
      })
      await polled.start(env.groupId)
      return polled
    }
    async function tick(w: KnowledgeWatcher, ms = 5000): Promise<void> {
      await vi.advanceTimersByTimeAsync(ms)
      await w.idle()
    }

    it('emits knowledge:changed for the section with a new file within one interval', async () => {
      const polled = await overCap()
      await writeFile(join(env.root, 'Notes', 'outside.md'), 'x')
      await tick(polled)
      await vi.waitFor(() => expect(emitted).toHaveLength(1))
      expect(emitted[0]).toMatchObject({ sectionIds: [env.notesId], reason: 'external' })
      await polled.dispose()
    })

    it('emits nothing when nothing changed', async () => {
      const polled = await overCap()
      await tick(polled, 15000)
      expect(emitted).toHaveLength(0)
      await polled.dispose()
    })

    it('stops polling on dispose', async () => {
      const polled = await overCap()
      await polled.dispose()
      await writeFile(join(env.root, 'Notes', 'late.md'), 'x')
      await tick(polled, 15000)
      expect(emitted).toHaveLength(0)
    })

    it('follows a relink to the new root', async () => {
      const polled = await overCap()
      const other = join(dir(), 'other-root')
      await mkdir(join(other, 'Notes'), { recursive: true })
      const root = { value: env.root }
      const relinked = make({
        getKnowledgeRoot: () => root.value,
        fileCap: 2,
        pollMs: 5000,
        countFiles: () => Promise.resolve(3)
      })
      await polled.dispose()
      await relinked.start(env.groupId)
      root.value = other
      await relinked.start(env.groupId)
      await writeFile(join(env.root, 'Notes', 'old-root.md'), 'x')
      await tick(relinked)
      expect(emitted).toHaveLength(0)
      await writeFile(join(other, 'Notes', 'new-root.md'), 'x')
      await tick(relinked)
      await vi.waitFor(() => expect(emitted).toHaveLength(1))
      await relinked.dispose()
    })
  })
})

describe('countWatchedFiles', () => {
  const dir = useTempDir()
  it('counts files to depth 2, skips ignored paths, and stops past the cap', async () => {
    const root = dir()
    await mkdir(join(root, 'Notes'))
    await mkdir(join(root, '.git'))
    for (const f of ['a.md', 'b.md', '.DS_Store']) await writeFile(join(root, 'Notes', f), 'x')
    await writeFile(join(root, '.git', 'HEAD'), 'x')
    expect(await countWatchedFiles(root, 100)).toBe(2)
    expect(await countWatchedFiles(root, 1)).toBeGreaterThan(1)
  })
})

describe('KnowledgeWatcher (real chokidar)', () => {
  const dir = useTempDir()
  let env: KnowledgeEnv
  let watcher: KnowledgeWatcher
  const emitted: Changed[] = []

  beforeEach(async () => {
    env = await createEnv(dir())
    emitted.length = 0
    watcher = new KnowledgeWatcher({
      getKnowledgeRoot: () => env.root,
      index: env.index,
      sectionsRepo: env.sectionsRepo,
      itemsRepo: env.itemsRepo,
      adoptFolders: (groupId) => env.sections.adoptFolders(groupId),
      emit: (_event, payload) => emitted.push(payload)
    })
    await watcher.start(env.groupId)
    await new Promise((r) => setTimeout(r, 800)) // let chokidar finish its initial scan
  })
  afterEach(async () => {
    await watcher.dispose()
    env.opened.sqlite.close()
  })

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('timed out waiting for knowledge:changed')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  it('picks up an outside file, an outside edit and a new folder within 5 s, and ignores own writes', async () => {
    await writeFile(join(env.root, 'Docs', 'outside.md'), 'hello')
    await waitFor(() => emitted.some((e) => e.sectionIds.length > 0))
    expect(emitted[0]?.reason).toBe('external')

    const before = emitted.length
    await atomicWriteFile(join(env.root, 'Notes', 'mine.md'), 'own write')
    await new Promise((r) => setTimeout(r, 1200))
    expect(emitted).toHaveLength(before)

    await mkdir(join(env.root, 'Runbooks'))
    await writeFile(join(env.root, 'Runbooks', 'deploy.md'), 'steps')
    await waitFor(() => emitted.some((e) => e.sectionsChanged === true))

    const docs = emitted[0]?.items?.[0]
    expect(docs?.revision).toBeTruthy()
    await utimes(join(env.root, 'Docs', 'outside.md'), new Date(), new Date(Date.now() + 5000))
  }, 15_000)
})

describe('KnowledgeWatcher root removal (real chokidar + availability service)', () => {
  const dir = useTempDir()
  let env: KnowledgeEnv
  let watcher: KnowledgeWatcher
  let availability: AvailabilityService
  let tick: (() => void) | undefined
  const events: unknown[] = []

  beforeEach(async () => {
    env = await createEnv(dir())
    events.length = 0
    tick = undefined
    availability = new AvailabilityService({
      projectsRepo: { listByGroup: () => [], update: () => undefined } as never,
      emit: (_event, payload) => events.push(payload),
      getLinkedRoot: () => env.root,
      setInterval: (fn) => {
        tick = fn
        return 1
      },
      clearInterval: () => undefined
    })
    watcher = new KnowledgeWatcher({
      getKnowledgeRoot: () => env.root,
      index: env.index,
      sectionsRepo: env.sectionsRepo,
      itemsRepo: env.itemsRepo,
      adoptFolders: (groupId) => env.sections.adoptFolders(groupId),
      emit: () => undefined,
      onRootGone: (groupId) => void availability.checkGroup(groupId)
    })
    await watcher.start(env.groupId)
    await new Promise((r) => setTimeout(r, 800)) // let chokidar finish its initial scan
    availability.recordKnowledgeBaseline(env.groupId, true)
    await availability.setOpenGroup(env.groupId)
  })
  afterEach(async () => {
    availability.stop()
    await watcher.dispose()
    env.opened.sqlite.close()
  })

  async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<number> {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for availability')
      await new Promise((r) => setTimeout(r, 25))
    }
    return Date.now() - start
  }

  const unavailable = (): unknown => ({
    groupId: env.groupId,
    knowledgeRoot: true,
    available: false
  })

  it.each([
    ['renamed', (root: string) => rename(root, `${root}-moved`)],
    ['deleted', (root: string) => rm(root, { recursive: true })]
  ])(
    'reports a %s root within 2 s, once, without waiting for the interval',
    async (_n, act) => {
      expect(events).toEqual([])
      await act(env.root)
      const ms = await waitFor(() => events.length > 0, 2000)
      console.info(`knowledge root ${_n}: availability event after ${ms} ms`)
      expect(events).toEqual([unavailable()])

      await new Promise((r) => setTimeout(r, 700))
      tick?.() // the next interval tick must not repeat the event
      await availability.checkGroup(env.groupId)
      expect(events).toEqual([unavailable()])
      expect(watcher.watchedGroupId).toBe(env.groupId)
    },
    10_000
  )
})

describe('KnowledgeWatcher nested items (real chokidar)', () => {
  const dir = useTempDir()
  it('reports a file added in a subfolder of a section', async () => {
    const env = await createEnv(dir())
    const emitted: Changed[] = []
    const watcher = new KnowledgeWatcher({
      getKnowledgeRoot: () => env.root,
      index: env.index,
      sectionsRepo: env.sectionsRepo,
      itemsRepo: env.itemsRepo,
      adoptFolders: (groupId) => env.sections.adoptFolders(groupId),
      emit: (_event, payload) => emitted.push(payload)
    })
    await mkdir(join(env.root, 'Notes', 'sub', 'deeper'), { recursive: true })
    await watcher.start(env.groupId)
    await new Promise((r) => setTimeout(r, 800))
    await writeFile(join(env.root, 'Notes', 'sub', 'deeper', 'n.md'), 'hi')
    const deadline = Date.now() + 5000
    while (!emitted.some((e) => e.sectionIds.includes(env.notesId))) {
      if (Date.now() > deadline) throw new Error('timed out waiting for nested add')
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(env.itemsRepo.listBySection(env.notesId).map((r) => r.relPath)).toEqual([
      'Notes/sub/deeper/n.md'
    ])
    await watcher.dispose()
    env.opened.sqlite.close()
  }, 15_000)
})
