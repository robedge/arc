import { describe, expect, it, vi } from 'vitest'
import { isSmokeRun, runSmoke } from '../../src/main/app/smoke'

function deps(open: () => { close: () => void }) {
  return { openDatabase: open, info: vi.fn(), error: vi.fn(), exit: vi.fn() }
}

describe('smoke run', () => {
  it('detects the flag in argv', () => {
    expect(isSmokeRun(['Arc', '--smoke'])).toBe(true)
    expect(isSmokeRun(['Arc'])).toBe(false)
  })

  it('opens, closes the database and exits 0', () => {
    const close = vi.fn()
    const d = deps(() => ({ close }))
    expect(runSmoke(d)).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    expect(d.exit).toHaveBeenCalledWith(0)
  })

  it('exits 1 when the database cannot be opened', () => {
    const d = deps(() => {
      throw new Error('boom')
    })
    expect(runSmoke(d)).toBe(1)
    expect(d.error).toHaveBeenCalled()
    expect(d.exit).toHaveBeenCalledWith(1)
  })
})
