import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
const emit = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured, emit)
})

function rig(modelsChanged = false) {
  const map = { claude: { state: 'ok' } }
  const providerStatus = {
    get: vi.fn(() => map),
    check: vi.fn(() => Promise.resolve(map)),
    getStatus: vi.fn((): unknown => undefined),
    ensureFresh: vi.fn(() => Promise.reject(new Error('probe failed'))),
    dismissUpdate: vi.fn()
  }
  const providerChecks = {
    runFullCheck: vi.fn(() => Promise.resolve()),
    refreshCursorCommands: vi.fn(),
    refreshCodexCommands: vi.fn()
  }
  const models = {
    refresh: vi.fn(() => Promise.resolve(modelsChanged)),
    all: vi.fn(() => ({ claude: [] }))
  }
  return { providerStatus, providerChecks, models, bypassDetector: { detect: vi.fn() } }
}

async function register(services: ReturnType<typeof rig>): Promise<void> {
  const { registerProviderHandlers } = await import('../../../../src/main/ipc/handlers/providers')
  registerProviderHandlers(services as unknown as AppServices)
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('provider handlers', () => {
  beforeEach(() => {
    captured.clear()
    emit.mockClear()
  })

  it('providers:check without a provider runs the full forced check', async () => {
    const services = rig()
    await register(services)
    await call(captured, 'providers:check', {})
    expect(services.providerChecks.runFullCheck).toHaveBeenCalledWith({ forceLatest: true })
    expect(services.providerStatus.check).not.toHaveBeenCalled()
  })

  it('checking Claude alone does not reload models or command lists', async () => {
    const services = rig()
    await register(services)
    await call(captured, 'providers:check', { provider: 'claude' })
    expect(services.providerStatus.check).toHaveBeenCalledWith('claude', { forceLatest: true })
    expect(services.models.refresh).not.toHaveBeenCalled()
  })

  it('checking Cursor reloads models, tells the renderer when they changed, and the commands', async () => {
    const services = rig(true)
    await register(services)
    await call(captured, 'providers:check', { provider: 'cursor' })
    await flush()
    expect(services.models.refresh).toHaveBeenCalledWith({ force: true })
    expect(emit).toHaveBeenCalledWith('providers:changed', expect.anything())
    expect(services.providerChecks.refreshCursorCommands).toHaveBeenCalledOnce()
    expect(services.providerChecks.refreshCodexCommands).not.toHaveBeenCalled()
  })

  it('checking Codex reloads its commands straight away', async () => {
    const services = rig()
    await register(services)
    await call(captured, 'providers:check', { provider: 'codex' })
    expect(services.providerChecks.refreshCodexCommands).toHaveBeenCalledOnce()
  })

  it('providers:models waits for providers without a status, even when the wait fails', async () => {
    const services = rig()
    await register(services)
    const result = await call(captured, 'providers:models')
    expect(services.providerStatus.ensureFresh.mock.calls.map((c) => String(c))).toEqual([
      'claude',
      'codex',
      'cursor'
    ])
    expect(services.models.refresh).toHaveBeenCalledOnce()
    expect(result).toEqual({ claude: [] })
  })
})
