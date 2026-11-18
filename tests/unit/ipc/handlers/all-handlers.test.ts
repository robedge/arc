import { describe, expect, it, vi } from 'vitest'
import { channelNames, sendSchemas } from '../../../../src/shared/ipc/contract'
import type { Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured)
})
vi.mock('../../../../src/main/logging', async () => (await import('./capture')).loggingMock())

describe('registerAllHandlers', () => {
  it('registers exactly one handler for every channel of the contract and every send channel', async () => {
    const { registerAllHandlers } = await import('../../../../src/main/ipc/handlers')
    registerAllHandlers({} as AppServices, {
      version: '1',
      relaunch: () => undefined,
      closeReady: () => undefined
    })
    expect([...captured.keys()].sort()).toEqual(
      [...channelNames, ...Object.keys(sendSchemas)].sort()
    )
  })
})
