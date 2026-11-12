import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import { channelSchemas } from '../../../../src/shared/ipc/contract'
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

  it('persists knowledge.suggestOnFinish, returns it and announces it', async () => {
    const store: Record<string, unknown> = { 'knowledge.suggestOnFinish': true }
    const appSettings = {
      get: vi.fn(),
      getAll: vi.fn(() => ({ ...store })),
      setMany: vi.fn((entries: Record<string, unknown>) => Object.assign(store, entries))
    }
    const services = {
      appSettings,
      commandCatalogue: { invalidate: vi.fn() },
      sessions: { knowledgeSuggestSettingChanged: vi.fn() }
    }
    await register(services as never)
    const result = await call(captured, 'settings:set', { 'knowledge.suggestOnFinish': false })
    expect(appSettings.setMany).toHaveBeenCalledWith(
      { 'knowledge.suggestOnFinish': false },
      expect.any(Number)
    )
    expect(result).toMatchObject({ 'knowledge.suggestOnFinish': false })
    expect(await call(captured, 'settings:get')).toMatchObject({
      'knowledge.suggestOnFinish': false
    })
    expect(emit).toHaveBeenCalledWith(
      'settings:changed',
      expect.objectContaining({ 'knowledge.suggestOnFinish': false })
    )
  })

  it('rejects a non-boolean knowledge.suggestOnFinish in the schema', () => {
    const schema = channelSchemas['settings:set']
    expect(schema.safeParse({ 'knowledge.suggestOnFinish': false }).success).toBe(true)
    expect(schema.safeParse({ 'knowledge.suggestOnFinish': 'no' }).success).toBe(false)
  })

  describe('telling open sessions about knowledge.suggestOnFinish', () => {
    function suggestRig(before: boolean, after: boolean) {
      let value = before
      const appSettings = {
        get: vi.fn((key: string) => (key === 'knowledge.suggestOnFinish' ? value : undefined)),
        getAll: vi.fn(() => ({ 'knowledge.suggestOnFinish': value })),
        setMany: vi.fn(() => {
          value = after
        })
      }
      const sessions = { knowledgeSuggestSettingChanged: vi.fn(), pluginsChanged: vi.fn() }
      return { appSettings, commandCatalogue: { invalidate: vi.fn() }, sessions }
    }

    it('calls the hook, after the value is saved, when it changed', async () => {
      const services = suggestRig(true, false)
      services.sessions.knowledgeSuggestSettingChanged.mockImplementation(() => {
        expect(services.appSettings.setMany).toHaveBeenCalled()
      })
      await register(services as never)
      await call(captured, 'settings:set', { 'knowledge.suggestOnFinish': false })
      expect(services.sessions.knowledgeSuggestSettingChanged).toHaveBeenCalledOnce()
    })

    it('does not call it when the value is the same', async () => {
      const services = suggestRig(true, true)
      await register(services as never)
      await call(captured, 'settings:set', { 'knowledge.suggestOnFinish': true })
      expect(services.sessions.knowledgeSuggestSettingChanged).not.toHaveBeenCalled()
    })

    it('does not call it when the patch leaves the key out', async () => {
      const services = suggestRig(true, true)
      await register(services as never)
      await call(captured, 'settings:set', { 'usage.checkClaudePlanOnLaunch': false })
      expect(services.sessions.knowledgeSuggestSettingChanged).not.toHaveBeenCalled()
    })
  })
})
