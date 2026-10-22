import { expect, it } from 'vitest'
import {
  isE2eOffscreen,
  mainWindowOptions,
  offscreenOrigin,
  showWindow,
  withE2eOffscreen
} from '../../src/main/app/window-options'

const displays = [
  { x: 0, y: 0, width: 1512, height: 982 },
  { x: -1920, y: 0, width: 1920, height: 1080 }
]

it('requires both env vars', () => {
  expect(isE2eOffscreen({ HARNESS_E2E: '1', HARNESS_E2E_OFFSCREEN: '1' })).toBe(true)
  expect(isE2eOffscreen({ HARNESS_E2E: '1' })).toBe(false)
  expect(isE2eOffscreen({ HARNESS_E2E_OFFSCREEN: '1' })).toBe(false)
  expect(isE2eOffscreen({})).toBe(false)
})

it('computes an origin beyond every display', () => {
  const { x, y } = offscreenOrigin(displays)
  expect(x).toBeGreaterThanOrEqual(1512)
  expect(y).toBeGreaterThanOrEqual(1080)
})

it('adds the origin but keeps size, only under both vars', () => {
  const base = mainWindowOptions('/p')
  const on = withE2eOffscreen(
    base,
    { HARNESS_E2E: '1', HARNESS_E2E_OFFSCREEN: '1' },
    () => displays
  )
  expect(on.x).toBeGreaterThan(1512)
  expect(on.enableLargerThanScreen).toBe(true)
  expect([on.width, on.height]).toEqual([1200, 800])
  const off = withE2eOffscreen(base, { HARNESS_E2E: '1' }, () => displays)
  expect(off).toBe(base)
  expect(off.x).toBeUndefined()
})

it('uses showInactive only under both vars', () => {
  const mk = (): { calls: string[]; show(): void; showInactive(): void } => {
    const calls: string[] = []
    return {
      calls,
      show: () => void calls.push('show'),
      showInactive: () => void calls.push('showInactive')
    }
  }
  const a = mk()
  showWindow(a, { HARNESS_E2E: '1', HARNESS_E2E_OFFSCREEN: '1' })
  expect(a.calls).toEqual(['showInactive'])
  const b = mk()
  showWindow(b, { HARNESS_E2E: '1' })
  expect(b.calls).toEqual(['show'])
})
