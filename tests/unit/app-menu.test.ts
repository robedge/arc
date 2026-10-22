import { expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildAppMenuTemplate } from '../../src/main/app/app-menu'

const build = (isDev: boolean, open = vi.fn()): MenuItemConstructorOptions[] =>
  buildAppMenuTemplate({ isDev, appName: 'Arc', openDesignPreview: open })

const sub = (t: MenuItemConstructorOptions[], label: string): MenuItemConstructorOptions[] =>
  (t.find((m) => m.label === label || m.role === label.toLowerCase())?.submenu ??
    []) as MenuItemConstructorOptions[]
const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.map((i) => i.role).filter((r): r is NonNullable<typeof r> => !!r)

it('has Help > Design Preview with the stable id, wired to the opener', () => {
  const open = vi.fn()
  const help = sub(build(false, open), 'Help')
  const item = help.find((i) => i.id === 'help-design-preview')
  expect(item?.label).toBe('Design Preview')
  ;(item?.click as () => void)()
  expect(open).toHaveBeenCalledOnce()
})

it('keeps all clipboard roles in Edit', () => {
  expect(roles(sub(build(false), 'Edit'))).toEqual(
    expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  )
})

it('offers reload and dev tools only in dev builds, and never zoom', () => {
  const prod = roles(sub(build(false), 'View'))
  const dev = roles(sub(build(true), 'View'))
  for (const r of ['reload', 'forceReload', 'toggleDevTools']) {
    expect(prod).not.toContain(r)
    expect(dev).toContain(r)
  }
  for (const r of [prod, dev]) {
    expect(r).toContain('togglefullscreen')
    expect(r.filter((x) => x.toLowerCase().includes('zoom'))).toEqual([])
  }
})

it('keeps quit as a role (routed through before-quit) and File > Close', () => {
  expect(roles(sub(build(false), 'Arc'))).toEqual(
    expect.arrayContaining(['about', 'hide', 'hideOthers', 'unhide', 'quit'])
  )
  expect(roles(sub(build(false), 'File'))).toEqual(['close'])
})
