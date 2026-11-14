import type { Rectangle } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  isE2eOffscreen,
  mainWindowOptions,
  offscreenOrigin,
  showWindow,
  withE2eOffscreen,
  withWorkAreaBounds
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

describe('withWorkAreaBounds', () => {
  const base = mainWindowOptions('/p')
  const bounds = (o: { x?: number; y?: number; width?: number; height?: number }): unknown => ({
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height
  })

  it('fills a work area that has a menu bar offset', () => {
    const workArea = { x: 0, y: 25, width: 1728, height: 1027 }
    expect(bounds(withWorkAreaBounds(base, {}, () => workArea))).toEqual(workArea)
  })

  it('fills a secondary display with a non-zero origin', () => {
    const workArea = { x: -1920, y: -200, width: 1920, height: 1055 }
    expect(bounds(withWorkAreaBounds(base, {}, () => workArea))).toEqual(workArea)
  })

  it('keeps the current options object in e2e runs, offscreen or not', () => {
    const getWorkArea = (): Rectangle => ({ x: 0, y: 25, width: 1728, height: 1027 })
    expect(withWorkAreaBounds(base, { HARNESS_E2E: '1' }, getWorkArea)).toBe(base)
    expect(
      withWorkAreaBounds(base, { HARNESS_E2E: '1', HARNESS_E2E_OFFSCREEN: '1' }, getWorkArea)
    ).toBe(base)
  })

  it('never asks for full screen and keeps the minimum size', () => {
    const o = withWorkAreaBounds(base, {}, () => ({ x: 0, y: 25, width: 1728, height: 1027 }))
    expect(o.fullscreen).toBeUndefined()
    expect(o.simpleFullscreen).toBeUndefined()
    expect(o.fullscreenable).toBeUndefined()
    expect([o.minWidth, o.minHeight]).toEqual([1100, 720])
    expect(o.show).toBe(false)
  })
})
