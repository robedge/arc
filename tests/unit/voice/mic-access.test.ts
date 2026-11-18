import { describe, expect, it, vi } from 'vitest'
import { createMicAccess, MIC_SETTINGS_URL } from '../../../src/main/voice/mic-access'

function make(status: string, env: Record<string, string> = {}) {
  const ask = vi.fn(() => Promise.resolve(true))
  const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve())
  const target = {}
  const mic = createMicAccess({ getStatus: () => status, ask, openExternal, env, target })
  return { mic, ask, openExternal, target }
}

describe('mic access', () => {
  it('maps the macOS status and treats an unknown one as not decided', () => {
    expect(make('granted').mic.status()).toBe('granted')
    expect(make('denied').mic.status()).toBe('denied')
    expect(make('restricted').mic.status()).toBe('restricted')
    expect(make('unknown').mic.status()).toBe('not-determined')
  })

  it('shows the prompt only while the status is not-determined', async () => {
    const undecided = make('not-determined')
    await expect(undecided.mic.ask()).resolves.toBe(true)
    expect(undecided.ask).toHaveBeenCalledTimes(1)
    for (const status of ['granted', 'denied', 'restricted']) {
      const m = make(status)
      await expect(m.mic.ask()).resolves.toBe(status === 'granted')
      expect(m.ask).not.toHaveBeenCalled()
    }
  })

  it('opens exactly the Microphone privacy pane', async () => {
    const m = make('denied')
    await m.mic.openSettings()
    expect(m.openExternal).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    )
    expect(MIC_SETTINGS_URL).toBe(m.openExternal.mock.calls[0]?.[0])
  })

  it('under e2e never reaches the prompt or System Settings', async () => {
    const m = make('not-determined', { HARNESS_E2E: '1', HARNESS_MIC_STATUS: 'denied' })
    expect(m.mic.status()).toBe('denied')
    await expect(m.mic.ask()).resolves.toBe(false)
    await m.mic.openSettings()
    expect(m.ask).not.toHaveBeenCalled()
    expect(m.openExternal).not.toHaveBeenCalled()
    expect(
      (m.target as { __e2e: { getMicSettingsOpens: () => number } }).__e2e.getMicSettingsOpens()
    ).toBe(1)
    expect(make('denied', { HARNESS_E2E: '1' }).mic.status()).toBe('granted')
  })
})
