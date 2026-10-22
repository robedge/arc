import { expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { isOwnNavigation, lockDownWindow } from '../../src/main/app/lockdown'

it('exact mode allows only the identical URL', () => {
  const own = { exact: 'file:///app/preview.html' }
  expect(isOwnNavigation('file:///app/preview.html', own)).toBe(true)
  expect(isOwnNavigation('file:///app/index.html', own)).toBe(false)
  expect(
    isOwnNavigation('http://localhost:5173/index.html', {
      exact: 'http://localhost:5173/preview.html'
    })
  ).toBe(false)
})

it('exact mode can resolve the URL lazily; origin mode matches the origin only', () => {
  expect(isOwnNavigation('file:///a.html', { exact: () => 'file:///a.html' })).toBe(true)
  expect(isOwnNavigation('http://localhost:5173/x', { origin: 'http://localhost:5173/' })).toBe(
    true
  )
  expect(isOwnNavigation('http://evil.test/', { origin: 'http://localhost:5173/' })).toBe(false)
  expect(isOwnNavigation('not a url', { origin: 'http://localhost:5173/' })).toBe(false)
})

it('denies window.open, webviews and foreign navigation', () => {
  const handlers = new Map<string, (...a: never[]) => void>()
  let openHandler: (() => { action: string }) | undefined
  const win = {
    webContents: {
      setWindowOpenHandler: (h: () => { action: string }) => (openHandler = h),
      on: (name: string, h: (...a: never[]) => void) => handlers.set(name, h)
    }
  } as unknown as BrowserWindow
  lockDownWindow(win, { exact: 'file:///p.html' })
  expect(openHandler?.()).toEqual({ action: 'deny' })
  const nav = (url: string): boolean => {
    const preventDefault = vi.fn()
    ;(handlers.get('will-navigate') as (e: unknown, u: string) => void)({ preventDefault }, url)
    return preventDefault.mock.calls.length > 0
  }
  expect(nav('file:///p.html')).toBe(false)
  expect(nav('file:///index.html')).toBe(true)
  const prevent = vi.fn()
  ;(handlers.get('will-attach-webview') as (e: unknown) => void)({ preventDefault: prevent })
  expect(prevent).toHaveBeenCalled()
})
