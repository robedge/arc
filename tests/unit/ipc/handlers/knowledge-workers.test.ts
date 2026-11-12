import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured)
})

describe('items:pick-import', () => {
  beforeEach(() => captured.clear())

  it('returns an empty report when the dialog is cancelled', async () => {
    const services = {
      knowledgeService: { importFiles: vi.fn() },
      shellService: {},
      dialogs: { pickFiles: vi.fn(() => Promise.resolve(null)) }
    }
    const { registerKnowledgeHandlers } =
      await import('../../../../src/main/ipc/handlers/knowledge')
    registerKnowledgeHandlers(services as unknown as AppServices)
    expect(await call(captured, 'items:pick-import', { sectionId: 's1' })).toEqual({
      added: [],
      failed: [],
      conflicts: []
    })
    expect(services.knowledgeService.importFiles).not.toHaveBeenCalled()
  })

  it('imports the picked files', async () => {
    const services = {
      knowledgeService: { importFiles: vi.fn(() => Promise.resolve('report')) },
      shellService: {},
      dialogs: { pickFiles: vi.fn(() => Promise.resolve(['/a.md'])) }
    }
    const { registerKnowledgeHandlers } =
      await import('../../../../src/main/ipc/handlers/knowledge')
    registerKnowledgeHandlers(services as unknown as AppServices)
    expect(await call(captured, 'items:pick-import', { sectionId: 's1' })).toBe('report')
    expect(services.knowledgeService.importFiles).toHaveBeenCalledWith('s1', ['/a.md'])
  })
})

describe('workers:continue', () => {
  beforeEach(() => captured.clear())

  it('continues one worker, or every worker of a session', async () => {
    const sessions = {
      continueWorker: vi.fn(() => Promise.resolve()),
      continueAllWorkers: vi.fn(() => Promise.resolve())
    }
    const { registerWorkerHandlers } = await import('../../../../src/main/ipc/handlers/workers')
    registerWorkerHandlers({ sessions } as unknown as AppServices)
    await call(captured, 'workers:continue', { workerId: 'w1' })
    expect(sessions.continueWorker).toHaveBeenCalledWith('w1')
    await call(captured, 'workers:continue', { sessionId: 's1', all: true })
    expect(sessions.continueAllWorkers).toHaveBeenCalledWith('s1')
  })
})
