import { mkdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { ProjectService } from '../../../src/main/groups/project-service'
import { AvailabilityService } from '../../../src/main/knowledge/availability-service'
import type { Dialogs } from '../../../src/main/platform/dialogs'
import { realMigrations } from '../db/helpers'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir()
let opened: OpenedDatabase
let work: string
let groupId: string
let projectsRepo: ProjectsRepo
const events: unknown[] = []

const dialogs: Dialogs = {
  pickFolders: () => Promise.resolve(null),
  pickFiles: () => Promise.resolve(null),
  pickSaveFolder: () => Promise.resolve(null)
}

beforeEach(async () => {
  work = await realpath(dir())
  events.length = 0
  opened = openDatabase({ dbPath: join(work, 'arc.db'), migrationsFolder: realMigrations })
  projectsRepo = new ProjectsRepo(opened.db)
  const groups = new GroupService({
    db: opened.db,
    groupsRepo: new GroupsRepo(opened.db),
    appDataDir: join(work, 'userData')
  })
  groupId = (await groups.create('Shop')).id
})
afterEach(() => {
  vi.useRealTimers()
  opened.sqlite.close()
})

function makeService(
  overrides: Partial<ConstructorParameters<typeof AvailabilityService>[0]> = {}
) {
  return new AvailabilityService({
    projectsRepo,
    emit: (_event, payload) => events.push(payload),
    detectGit: () => Promise.resolve(false),
    ...overrides
  })
}

async function addProject(name: string): Promise<{ id: string; path: string }> {
  const path = join(work, name)
  await mkdir(path)
  const ps = new ProjectService({ db: opened.db, projectsRepo, dialogs })
  const res = await ps.add(groupId, [path])
  return { id: res.added[0]!.id, path }
}

describe('AvailabilityService.checkGroup', () => {
  it('emits only when the status changes', async () => {
    const p = await addProject('alpha')
    const svc = makeService()

    await svc.checkGroup(groupId)
    expect(events).toEqual([]) // first observation records without emitting

    await rename(p.path, join(work, 'moved'))
    await svc.checkGroup(groupId)
    expect(events).toEqual([{ groupId, projectId: p.id, available: false }])

    await svc.checkGroup(groupId)
    expect(events).toHaveLength(1)

    await rename(join(work, 'moved'), p.path)
    await svc.checkGroup(groupId)
    expect(events).toHaveLength(2)
    expect(events[1]).toEqual({ groupId, projectId: p.id, available: true })
  })

  it('a project added after groups:open emits unavailable on the next check after its folder is moved', async () => {
    const svc = makeService()
    await svc.setOpenGroup(groupId)
    svc.stop()

    const p = await addProject('alpha')
    svc.recordBaseline(p.id, true) // what the bootstrap add handler does with the returned project

    await rename(p.path, join(work, 'moved'))
    await svc.checkGroup(groupId)
    expect(events).toEqual([{ groupId, projectId: p.id, available: false }])
  })

  it('refreshes last_seen_at for available projects only', async () => {
    const p = await addProject('alpha')
    const svc = makeService({ now: () => 4242 })
    await svc.checkGroup(groupId)
    expect(projectsRepo.getById(p.id)?.lastSeenAt).toBe(4242)

    await rename(p.path, join(work, 'moved'))
    const svc2 = makeService({ now: () => 9999 })
    await svc2.checkGroup(groupId)
    expect(projectsRepo.getById(p.id)?.lastSeenAt).toBe(4242)
  })
})

describe('AvailabilityService.setOpenGroup', () => {
  it('checks immediately, every 30 s, clears on switch and stops on null', async () => {
    const checked: string[] = []
    const timers = new Map<number, { fn: () => void; ms: number }>()
    const cleared: number[] = []
    let nextTimer = 1
    const svc = makeService({
      checkDir: (path) => {
        checked.push(path)
        return Promise.resolve(true)
      },
      setInterval: (fn, ms) => {
        const id = nextTimer++
        timers.set(id, { fn, ms })
        return id
      },
      clearInterval: (h) => {
        cleared.push(h as number)
        timers.delete(h as number)
      }
    })
    await addProject('alpha')

    svc.setOpenGroup(groupId)
    await vi.waitFor(() => expect(checked).toHaveLength(1))
    expect([...timers.values()].map((t) => t.ms)).toEqual([30_000])

    timers.get(1)?.fn()
    await vi.waitFor(() => expect(checked).toHaveLength(2))

    svc.setOpenGroup('other-group')
    expect(cleared).toEqual([1])
    expect(timers.size).toBe(1)

    svc.setOpenGroup(null)
    expect(cleared).toEqual([1, 2])
    expect(timers.size).toBe(0)
  })

  it('fires on real fake timers every 30 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const checkDir = vi.fn(() => Promise.resolve(true))
    const svc = makeService({ checkDir })
    await addProject('alpha')

    svc.setOpenGroup(groupId)
    await vi.waitFor(() => expect(checkDir).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkDir).toHaveBeenCalledTimes(2)
    svc.setOpenGroup(null)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(checkDir).toHaveBeenCalledTimes(2)
  })
})

describe('AvailabilityService knowledge root', () => {
  it('emits knowledgeRoot changes only, calls the watcher hook, and ignores app-stored groups', async () => {
    const root = join(work, 'linked-knowledge')
    await mkdir(root)
    let linked: string | null = root
    const changes: [string, boolean][] = []
    const svc = makeService({
      getLinkedRoot: () => linked,
      onKnowledgeRootChange: (id, available) => {
        changes.push([id, available])
      }
    })

    await svc.checkGroup(groupId)
    expect(events).toEqual([]) // first observation: the renderer already has it

    await rename(root, join(work, 'gone'))
    await svc.checkGroup(groupId)
    expect(events).toEqual([{ groupId, knowledgeRoot: true, available: false }])
    expect(changes).toEqual([[groupId, false]])

    await svc.checkGroup(groupId)
    expect(events).toHaveLength(1) // unchanged: no event

    await rename(join(work, 'gone'), root)
    await svc.checkGroup(groupId)
    expect(events[1]).toEqual({ groupId, knowledgeRoot: true, available: true })
    expect(changes).toEqual([
      [groupId, false],
      [groupId, true]
    ])

    linked = null // unlinked: status is forgotten, nothing emitted
    await rename(root, join(work, 'gone2'))
    await svc.checkGroup(groupId)
    expect(events).toHaveLength(2)
  })

  it('uses the baseline the renderer was given (storage:get), so a missing folder at start recovers with an event', async () => {
    const root = join(work, 'k')
    const svc = makeService({ getLinkedRoot: () => root })
    svc.recordKnowledgeBaseline(groupId, false) // storage:get reported "not found"
    await svc.checkGroup(groupId)
    expect(events).toEqual([])
    await mkdir(root)
    await svc.checkGroup(groupId)
    expect(events).toEqual([{ groupId, knowledgeRoot: true, available: true }])
  })

  it('survives a failing hook and a deleted group, and checks on the 30 s timer', async () => {
    const root = join(work, 'k2')
    await mkdir(root)
    let fire: (() => void) | undefined
    let throwing = false
    const svc = makeService({
      getLinkedRoot: () => {
        if (throwing) throw new Error('group deleted')
        return root
      },
      onKnowledgeRootChange: () => {
        throw new Error('watcher failed')
      },
      setInterval: (fn) => {
        fire = fn
        return 1
      },
      clearInterval: () => undefined
    })
    await svc.setOpenGroup(groupId)
    await rename(root, join(work, 'k2-gone'))
    fire?.()
    await vi.waitFor(() => expect(events).toHaveLength(1))
    throwing = true
    await expect(svc.checkGroup(groupId)).resolves.toBeUndefined()
  })
})
