import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured)
})
vi.mock('../../../../src/main/logging', async () => (await import('./capture')).loggingMock())

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function projectRig(added: { id: string; available: boolean }[]) {
  return {
    projectService: {
      pick: vi.fn(() => Promise.resolve({ added })),
      add: vi.fn(() => Promise.resolve({ added })),
      remove: vi.fn(),
      list: vi.fn(() => Promise.resolve(added)),
      relocate: vi.fn(() => Promise.resolve({ id: 'p1', available: true }))
    },
    availability: {
      recordBaseline: vi.fn(),
      checkGroup: vi.fn(() => Promise.resolve())
    },
    sessions: { groupChanged: vi.fn(() => Promise.resolve()) }
  }
}

describe('project handlers', () => {
  beforeEach(() => captured.clear())

  async function register(rig: ReturnType<typeof projectRig>): Promise<void> {
    const { registerProjectHandlers } = await import('../../../../src/main/ipc/handlers/groups')
    registerProjectHandlers(rig as unknown as AppServices)
  }

  it('projects:add records the baselines and updates open sessions only when something was added', async () => {
    const rig = projectRig([{ id: 'p1', available: true }])
    await register(rig)
    await call(captured, 'projects:add', { groupId: 'g1', paths: ['/a'] })
    expect(rig.availability.recordBaseline).toHaveBeenCalledWith('p1', true)
    expect(rig.sessions.groupChanged).toHaveBeenCalledWith('g1', { kind: 'projects' })

    const none = projectRig([])
    captured.clear()
    await register(none)
    await call(captured, 'projects:pick', { groupId: 'g1' })
    expect(none.sessions.groupChanged).not.toHaveBeenCalled()
  })

  it('projects:relocate re-checks the group and tells every group session', async () => {
    const rig = projectRig([])
    await register(rig)
    await call(captured, 'projects:relocate', { groupId: 'g1', projectId: 'p1' })
    expect(rig.availability.checkGroup).toHaveBeenCalledWith('g1')
    expect(rig.sessions.groupChanged).toHaveBeenCalledWith(null, { kind: 'projects' })
  })

  it('a failing session update does not fail the call', async () => {
    const rig = projectRig([])
    rig.sessions.groupChanged.mockRejectedValue(new Error('boom'))
    await register(rig)
    expect(() =>
      call(captured, 'projects:remove', { groupId: 'g1', projectId: 'p1' })
    ).not.toThrow()
    await flush()
    expect(rig.sessions.groupChanged).toHaveBeenCalledOnce()
  })
})

describe('storage handlers', () => {
  beforeEach(() => captured.clear())

  it('records the knowledge baseline of the state it returns and updates sessions on link', async () => {
    const state = { mode: 'linked', available: true }
    const rig = {
      storageService: {
        link: vi.fn(() => Promise.resolve(state)),
        locate: vi.fn(() => Promise.resolve({ located: false }))
      },
      sectionService: {},
      availability: { recordKnowledgeBaseline: vi.fn() },
      sessions: { groupChanged: vi.fn(() => Promise.resolve()) }
    }
    const { registerStorageHandlers } = await import('../../../../src/main/ipc/handlers/storage')
    registerStorageHandlers(rig as unknown as AppServices)
    await call(captured, 'storage:link', { groupId: 'g1', token: 't', choice: 'keep' })
    expect(rig.availability.recordKnowledgeBaseline).toHaveBeenCalledWith('g1', true)
    expect(rig.sessions.groupChanged).toHaveBeenCalledWith('g1', { kind: 'knowledge' })

    await call(captured, 'storage:locate', { groupId: 'g1' })
    expect(rig.sessions.groupChanged).toHaveBeenCalledTimes(1)
  })
})
