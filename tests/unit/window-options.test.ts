import { expect, it } from 'vitest'
import { HUD_BACKGROUND, mainWindowOptions } from '../../src/main/app/window-options'

it('enforces the minimum size, HUD ground color and inset title bar', () => {
  const o = mainWindowOptions('/p/index.cjs')
  expect(o.minWidth).toBe(1100)
  expect(o.minHeight).toBe(720)
  expect(HUD_BACKGROUND).toBe('#03080F')
  expect(o.backgroundColor).toBe('#03080F')
  expect(o.titleBarStyle).toBe('hiddenInset')
  expect(o.trafficLightPosition).toEqual({ x: 16, y: 14 })
})

it('keeps the hardened web preferences', () => {
  expect(mainWindowOptions('/p/index.cjs').webPreferences).toEqual({
    preload: '/p/index.cjs',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true
  })
})
