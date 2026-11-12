import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
const emit = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured, emit)
})

type Settings = { 'agents.loadOff': { workers: string[]; brain: string[] } }

function rig(before: string[], after: string[]) {
  const state: Settings = { 'agents.loadOff': { workers: before, brain: [] } }
  const appSettings = {
    get: vi.fn(() => state['agents.loadOff']),
    getAll: vi.fn(() => state),
    setMany: vi.fn(() => {
      state['agents.loadOff'] = { workers: after, brain: [] }
    })
  }
  const commandCatalogue = { invalidate: vi.fn() }
  const sessions = { pluginsChanged: vi.fn(() => Promise.resolve()) }
  return { appSettings, commandCatalogue, sessions }
}

async function register(services: ReturnType<typeof rig>): Promise<void> {
  const { registerSettingsHandlers } = await import('../../../../src/main/ipc/handlers/settings')
  registerSettingsHandlers(services as unknown as AppServices)
}

describe('settings:set', () => {
  beforeEach(() => {
    captured.clear()
    emit.mockClear()
  })

  it('refreshes the command lists and the sessions when the Workers selection changed', async () => {
    const services = rig(['a'], ['a', 'b'])
    await register(services)
    const loadOff = { workers: ['a', 'b'], brain: [] }
    await call(captured, 'settings:set', { 'agents.loadOff': loadOff })
    expect(services.appSettings.setMany).toHaveBeenCalledWith(
      { 'agents.loadOff': loadOff },
      expect.any(Number)
    )
    expect(services.commandCatalogue.invalidate).toHaveBeenCalledOnce()
    expect(emit).toHaveBeenCalledWith('commands:changed', {})
    expect(services.sessions.pluginsChanged).toHaveBeenCalledOnce()
  })

  it('treats the same keys in another order as unchanged', async () => {
    const services = rig(['a', 'b'], ['b', 'a'])
    await register(services)
    await call(captured, 'settings:set', { 'agents.loadOff': { workers: ['b', 'a'], brain: [] } })
    expect(services.commandCatalogue.invalidate).not.toHaveBeenCalled()
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('settings:changed', expect.anything())
  })

  it('does not touch the load selection when the patch leaves it out', async () => {
    const services = rig(['a'], ['a'])
    await register(services)
    await call(captured, 'settings:set', { 'usage.checkClaudePlanOnLaunch': false })
    expect(services.appSettings.setMany).toHaveBeenCalledWith(
      { 'usage.checkClaudePlanOnLaunch': false },
      expect.any(Number)
    )
    expect(services.commandCatalogue.invalidate).not.toHaveBeenCalled()
  })
})
