// @spec: 016-voice-companion
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, type Captured } from './capture'
import type { AppServices } from '../../../../src/main/app/app-services'

const captured = vi.hoisted<Captured>(() => new Map())
const emit = vi.hoisted(() => vi.fn())
vi.mock('../../../../src/main/ipc/register', async () => {
  const { registerMock } = await import('./capture')
  return registerMock(captured, emit)
})

const speechHost = {
  open: vi.fn(async () => undefined),
  close: vi.fn(),
  beginUtterance: vi.fn(async () => undefined),
  endUtterance: vi.fn(async () => 'hello there'),
  cancelUtterance: vi.fn(),
  pcm: vi.fn()
}
const micAccess = {
  status: vi.fn(() => 'denied'),
  ask: vi.fn(async () => true),
  openSettings: vi.fn(async () => undefined)
}

async function register(isFake: boolean): Promise<void> {
  const { registerVoiceHandlers } = await import('../../../../src/main/ipc/handlers/voice')
  const voiceModels = {
    status: vi.fn(async () => []),
    isFake,
    delete: vi.fn(async () => undefined)
  }
  registerVoiceHandlers({ voiceModels, speechHost, micAccess } as unknown as AppServices)
}

describe('voice:models-status', () => {
  beforeEach(() => captured.clear())

  it('marks stub models as fake so the renderer uses its stub speech engine', async () => {
    await register(true)
    const res = await call(captured, 'voice:models-status', {})
    expect(res).toEqual({ models: [], fake: true })
  })

  it('leaves fake out for real models', async () => {
    await register(false)
    const res = await call(captured, 'voice:models-status', {})
    expect(res).toEqual({ models: [] })
  })
})

describe('microphone and speech channels', () => {
  beforeEach(() => {
    captured.clear()
    vi.clearAllMocks()
  })

  it('reports the mic status, asks for access and opens the privacy pane', async () => {
    await register(false)
    expect(await call(captured, 'voice:mic-status', {})).toEqual({ status: 'denied' })
    expect(await call(captured, 'voice:ask-mic', {})).toEqual({ granted: true })
    expect(await call(captured, 'voice:open-mic-settings', {})).toEqual({})
    expect(micAccess.openSettings).toHaveBeenCalledTimes(1)
  })

  it('drives the speech host: open, begin, end returns the text, cancel, close', async () => {
    await register(false)
    expect(await call(captured, 'voice:open', {})).toEqual({})
    expect(await call(captured, 'voice:begin-utterance', { utteranceId: 'u1' })).toEqual({})
    expect(await call(captured, 'voice:end-utterance', { utteranceId: 'u1' })).toEqual({
      text: 'hello there'
    })
    expect(await call(captured, 'voice:cancel-utterance', { utteranceId: 'u1' })).toEqual({})
    expect(await call(captured, 'voice:close', {})).toEqual({})
    expect(speechHost.beginUtterance).toHaveBeenCalledWith('u1')
    expect(speechHost.cancelUtterance).toHaveBeenCalledWith('u1')
    expect(speechHost.close).toHaveBeenCalledTimes(1)
  })

  it('forwards voice:pcm audio to the speech host', async () => {
    await register(false)
    const samples = new ArrayBuffer(3200)
    await call(captured, 'voice:pcm', { utteranceId: 'u1', seq: 3, samples })
    expect(speechHost.pcm).toHaveBeenCalledWith('u1', 3, samples)
  })

  it('stops the engine before deleting the models it has open', async () => {
    await register(false)
    await call(captured, 'voice:delete-models', {})
    expect(speechHost.close).toHaveBeenCalledTimes(1)
  })
})
