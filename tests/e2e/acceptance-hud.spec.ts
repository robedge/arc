// @spec: 002-arc-hud-design-system
// @regression
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

const CYAN = 'rgb(0, 229, 255)'
const RED = 'rgb(255, 107, 107)'

async function newGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
}

async function queueDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

async function openPreview(app: ElectronApplication): Promise<Page> {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('help-design-preview')?.click()
  })
  await expect.poll(() => app.windows().length).toBe(2)
  const page = app.windows().find((w) => w.url().endsWith('/preview.html'))
  if (!page) throw new Error('preview window not found')
  await page.waitForLoadState('domcontentloaded')
  return page
}

/** Creates a note through the IPC bridge and returns its id. */
async function seedNote(page: Page, sectionId: string, title: string): Promise<string> {
  const res = await page.evaluate((a) => window.harness.invoke('items:create', a), {
    sectionId,
    title
  })
  if (!res.ok) throw new Error(`items:create failed for ${title}`)
  return res.data.id
}

async function sectionId(page: Page, groupName: string, kind: string): Promise<string> {
  const groups = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  const group = groups.ok ? groups.data.find((g) => g.name === groupName) : undefined
  if (!group) throw new Error('group not found')
  const sections = await page.evaluate(
    (id) => window.harness.invoke('sections:list', { groupId: id }),
    group.id
  )
  const section = sections.ok ? sections.data.find((s) => s.kind === kind) : undefined
  if (!section) throw new Error(`no ${kind} section`)
  return section.id
}

/** Resolves a CSS color the way the browser reports it (rgb, rgba or oklab), for comparisons. */
function resolveColor(page: Page, color: string): Promise<string> {
  return page.evaluate((c) => {
    const probe = document.createElement('span')
    probe.style.color = c
    document.body.append(probe)
    const out = getComputedStyle(probe).color
    probe.remove()
    return out
  }, color)
}

/** The focus ring is a 120ms box-shadow transition, so wait for it to settle on the active element. */
async function expectFocusRing(page: Page, label: string): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow), {
      message: label
    })
    .toContain(CYAN)
}

/** Computed style of the element a locator points at. */
function css(locator: Locator, prop: string): Promise<string> {
  return locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)
}

test('2.1 opens on a navy grid ground with the ARC wordmark and ring, and stays dark under Light', async ({
  window: page
}) => {
  const wordmark = page.getByRole('navigation', { name: 'Groups' }).getByRole('heading', {
    level: 1
  })
  await expect(wordmark).toContainText('ARC')
  await expect(wordmark.locator('svg.ring-logo')).toBeVisible()

  const body = page.locator('body')
  expect(await css(body, 'background-color')).toBe('rgb(3, 8, 15)')
  const image = await css(body, 'background-image')
  expect(image.match(/linear-gradient/g)).toHaveLength(2)

  // macOS Light appearance reaches the page as prefers-color-scheme: light.
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await css(body, 'background-color')).toBe('rgb(3, 8, 15)')
  expect(await css(page.locator('html'), 'color-scheme')).toBe('dark')
  expect(await css(wordmark, 'color')).not.toBe('rgb(0, 0, 0)')
  const dark = await page.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)
  expect(dark).toBe(true)
  await expect(wordmark.locator('svg.ring-logo')).toBeVisible()
})

test('2.1/2.8 headings and labels are uppercase and tracked; paths are monospace', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-hud-')))
  try {
    const project = join(root, 'api')
    await mkdir(project)
    await newGroup(page, 'Storefront')
    await page.getByRole('tab', { name: 'Projects' }).click()
    await queueDialog(app, [project])
    await page.getByRole('button', { name: 'Add Project' }).click()
    const path = page.getByRole('list', { name: 'Projects' }).getByText(project)
    await expect(path).toBeVisible()

    expect(await css(path, 'font-family')).toContain('JetBrains Mono')

    const heading = page.getByRole('heading', { name: 'Storefront', level: 2 })
    expect(await css(heading, 'text-transform')).toBe('uppercase')
    expect(await css(heading, 'font-family')).toContain('Orbitron')
    expect(parseFloat(await css(heading, 'letter-spacing'))).toBeGreaterThan(2)

    const tab = page.getByRole('tab', { name: 'Notes' })
    expect(await css(tab, 'text-transform')).toBe('uppercase')
    expect(await css(tab, 'font-family')).toContain('Rajdhani')
    expect(parseFloat(await css(tab, 'letter-spacing'))).toBeGreaterThan(1)

    const wordmarkText = page.getByRole('navigation', { name: 'Groups' }).getByText('ARC')
    expect(await css(wordmarkText, 'font-family')).toContain('Orbitron')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('2.2 an opened group frames the sidebar, header, item list and editor with cyan corner brackets', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByLabel('Title', { exact: true }).fill('Service map')
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.locator('.cm-content')).toBeVisible()

  const panels = [
    page.getByRole('navigation', { name: 'Groups' }),
    page
      .locator('.hud-panel')
      .filter({ has: page.getByRole('heading', { name: 'Shop', level: 2 }) }),
    page.locator('.hud-panel').filter({ has: page.getByRole('list', { name: 'Items' }) }),
    page.locator('.hud-panel').filter({ has: page.locator('.cm-content') })
  ]
  for (const panel of panels) {
    const first = panel.first()
    await expect(first).toBeVisible()
    const tl = first.locator('> [data-bracket="tl"]')
    const br = first.locator('> [data-bracket="br"]')
    await expect(tl).toHaveCount(1)
    await expect(br).toHaveCount(1)
    expect(await css(tl, 'border-top-color')).toBe(CYAN)
    expect(await css(br, 'border-bottom-color')).toBe(CYAN)
    // A thin cyan-family outline frames the panel.
    expect(await css(first, 'border-top-width')).toBe('1px')
    expect(await css(first, 'border-top-color')).toMatch(/^rgba\(0, 229, 255, /)
  }
})

test('2.2/2.3 delete confirmation: red Delete, outlined Cancel, Escape closes without deleting; dialog traps focus', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  const nav = page.getByRole('navigation', { name: 'Groups' })
  await nav.getByRole('button', { name: 'Group options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Group' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()

  const del = dialog.getByRole('button', { name: 'Delete', exact: true })
  const cancel = dialog.getByRole('button', { name: 'Cancel' })
  const delBg = await css(del, 'background-color')
  const [r, g, b] = delBg.match(/\d+(\.\d+)?/g)!.map(Number) as [number, number, number]
  expect(r).toBeGreaterThan(g * 1.5)
  expect(r).toBeGreaterThan(b * 1.5)
  expect(await css(del, 'border-top-color')).toMatch(/^rgb\(255, 107, 107|^rgba\(255, 107, 107/)
  expect(await css(cancel, 'border-top-width')).toBe('1px')
  expect(await css(cancel, 'background-color')).toMatch(/^rgba\(0, 0, 0, 0\)|^transparent/)

  // Focus stays inside the dialog and every stop shows the cyan focus ring.
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      return { inside: !!el?.closest('[role="dialog"]') }
    })
    expect(stop.inside).toBe(true)
    await expectFocusRing(page, `dialog stop ${i}`)
  }

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(nav.getByText('Shop')).toBeVisible()
  const listed = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  expect(listed.ok && listed.data.map((x) => x.name)).toEqual(['Shop'])
})

test('2.3 rename opens centered over a dimmed, blurred window with corner brackets', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Group options' })
    .click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // Let the draw-in finish so the box is measured at full size.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))
  )
  await page
    .locator('[data-modal-scrim]')
    .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)))

  const box = (await dialog.boundingBox())!
  const view = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  expect(Math.abs(box.x + box.width / 2 - view.w / 2)).toBeLessThanOrEqual(2)
  expect(Math.abs(box.y + box.height / 2 - view.h / 2)).toBeLessThanOrEqual(2)

  const scrim = page.locator('[data-modal-scrim]')
  const scrimBox = (await scrim.boundingBox())!
  expect(scrimBox).toMatchObject({ x: 0, y: 0, width: view.w, height: view.h })
  expect(await css(scrim, 'backdrop-filter')).toMatch(/blur\([1-9]/)
  const alpha = Number((await css(scrim, 'background-color')).match(/[\d.]+/g)![3])
  expect(alpha).toBeGreaterThan(0.3)
  await expect(dialog.locator('[data-bracket="tl"]')).toHaveCount(1)
  await expect(dialog.locator('[data-bracket="br"]')).toHaveCount(1)
})

test('2.2 an empty group name outlines the field in red with the message and icon under it', async ({
  window: page
}) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Group name').fill('')
  await dialog.getByRole('button', { name: 'Create' }).click()

  const field = dialog.getByLabel('Group name')
  const error = dialog.getByRole('alert')
  await expect(error).toHaveText('Group name is required.')
  expect(await css(field, 'border-top-color')).toBe(RED)
  expect(await css(error, 'color')).toBe(RED)
  await expect(error.locator('svg')).toHaveCount(1)
  const f = (await field.boundingBox())!
  const e = (await error.boundingBox())!
  expect(e.y).toBeGreaterThanOrEqual(f.y + f.height)
})

test('2.2 Tab through the group screen shows a cyan focus ring on every visible stop', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  await page.getByRole('tab', { name: 'Projects' }).click()
  await page.locator('body').click({ position: { x: 1, y: 1 } })

  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab')
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body) return null
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return {
        id: `${el.tagName}:${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30)}`,
        visible:
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0'
      }
    })
    if (!stop || seen.has(stop.id)) break
    seen.add(stop.id)
    expect(stop.visible, stop.id).toBe(true)
    await expectFocusRing(page, stop.id)
  }
  // New Group, the group row and its options, the section tabs, and the screen actions.
  expect(seen.size).toBeGreaterThanOrEqual(6)
})

test('2.4 a bad link address shows a red error with an icon and the exact wording', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  await page.getByRole('tab', { name: 'Links' }).click()
  await page.getByRole('button', { name: 'Add Link' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Address').fill('wiki.example.com')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()

  const error = dialog.getByRole('alert')
  await expect(error).toHaveText('Enter a full web address starting with http:// or https://.')
  expect(await css(error, 'color')).toBe(RED)
  await expect(error.locator('svg')).toHaveCount(1)
})

test('2.4 a note changed on disk while dirty shows an amber banner with Reload and Keep mine', async ({
  window: page,
  userDataDir
}) => {
  await newGroup(page, 'Shop')
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByLabel('Title', { exact: true }).fill('Service map')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.locator('.cm-content').click()
  await page.keyboard.type('first')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })

  const { readdir } = await import('node:fs/promises')
  const groups = join(userDataDir, 'groups')
  const [id] = await readdir(groups)
  const notePath = join(groups, id ?? '', 'knowledge', 'Notes', 'Service map.md')
  await page.locator('.cm-content').click()
  await page.keyboard.type(' typed-locally')
  await writeFile(notePath, '# Changed outside\n')

  const banner = page.getByRole('alert').filter({ hasText: 'changed on disk' })
  await expect(banner).toBeVisible({ timeout: 5000 })
  await expect(banner.getByRole('button', { name: 'Reload' })).toBeVisible()
  await expect(banner.getByRole('button', { name: 'Keep mine' })).toBeVisible()
  await expect(banner).toHaveAttribute('data-kind', 'warning')
  expect(await css(banner, 'border-top-color')).toBe(
    await resolveColor(page, 'color-mix(in oklab, #ffb74d 55%, transparent)')
  )
  await expect(banner.locator('svg').first()).toBeVisible()
  const top = (await banner.boundingBox())!.y
  const editor = (await page.locator('.cm-content').boundingBox())!.y
  expect(top).toBeLessThan(editor)
})

test('2.4 a renamed knowledge folder shows the warning banner with Locate and Use app storage', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-hudlink-')))
  const folder = join(root, 'kb')
  try {
    await mkdir(join(folder, 'Notes'), { recursive: true })
    await newGroup(page, 'Shop')
    await queueDialog(app, [folder])
    await page.getByRole('button', { name: 'Link folder…' }).click()
    const link = page.getByRole('dialog')
    if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
      await link.getByRole('button', { name: 'Link folder' }).click()
      await expect(link).toBeHidden()
    }
    await expect(
      page.getByRole('region', { name: 'Knowledge storage' }).getByText(folder)
    ).toBeVisible()
    await rename(folder, join(root, 'kb-renamed'))

    await newGroup(page, 'Other')
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    const banner = page.getByRole('alert').filter({ hasText: 'Knowledge folder not found' })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toHaveAttribute('data-kind', 'warning')
    await expect(banner.getByRole('button', { name: 'Locate…' })).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Use app storage' })).toBeVisible()
    expect(await css(banner, 'border-top-color')).toBe(
      await resolveColor(page, 'color-mix(in oklab, #ffb74d 55%, transparent)')
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('2.5/2.9 Design Preview: amber badge with 2, attention dialog cards, Close label, Escape keeps 2', async ({
  app,
  window: main
}) => {
  await expect(main.getByRole('heading', { name: 'Arc' })).toBeVisible()
  const preview = await openPreview(app)
  const badge = preview.getByRole('button', { name: /Needs attention/ })
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('Needs attention')
  await expect(badge.locator('[data-count]')).toHaveText('2')
  expect(await css(badge, 'border-top-color')).toBe('rgb(255, 183, 77)')

  await badge.click()
  const dialog = preview.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Deny' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(dialog.getByRole('textbox')).toHaveCount(1)
  // Measure at rest: the draw-in scales the dialog slightly while it runs.
  await dialog.evaluate((el) =>
    Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished))
  )
  for (const name of ['Approve', 'Deny']) {
    const h = (await dialog.getByRole('button', { name }).boundingBox())!.height
    expect(h).toBeGreaterThanOrEqual(44)
  }
  const action = dialog.locator('[data-action]')
  expect(await css(action, 'font-family')).toContain('JetBrains Mono')

  // VoiceOver reads the accessible name; the icon-only close button must be "Close".
  await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeVisible()

  await preview.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(badge.locator('[data-count]')).toHaveText('2')
})

test('2.6 Reduce Motion: the badge glows steadily and a dialog appears with no animation; motion on pulses', async ({
  app,
  window: page
}) => {
  const preview = await openPreview(app)
  const badge = preview.getByRole('button', { name: /Needs attention/ })
  await expect(badge).toBeVisible()

  await preview.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => badge.evaluate((el) => el.getAnimations().length)).toBeGreaterThan(0)

  await preview.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => badge.evaluate((el) => el.getAnimations().length)).toBe(0)
  expect(await css(badge, 'box-shadow')).not.toBe('none')

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByRole('button', { name: 'New Group' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  expect(await css(dialog, 'opacity')).toBe('1')
})

test('2.6 with motion on, Tab then Enter on a dialog button works immediately', async ({
  window: page
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('button', { name: 'New Group' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  // No waiting for the draw-in: Tab from the name field lands on Cancel, Enter activates it.
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden({ timeout: 1000 })
})

test('2.7 only the panel under the cursor scrolls; the window, header, nav and sidebar stay put', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  const notes = await sectionId(page, 'Shop', 'notes')
  for (let i = 0; i < 60; i++) await seedNote(page, notes, `Note ${String(i).padStart(2, '0')}`)
  await page.getByRole('tab', { name: 'Notes' }).click()
  const list = page.getByRole('list', { name: 'Items' })
  await expect(list.getByRole('listitem')).toHaveCount(60)

  const pos = async (): Promise<Record<string, number>> => ({
    header: (await page.getByRole('heading', { name: 'Shop', level: 2 }).boundingBox())!.y,
    nav: (await page.getByRole('tab', { name: 'Notes' }).boundingBox())!.y,
    sidebar: (await page.getByRole('navigation', { name: 'Groups' }).boundingBox())!.y
  })
  const before = await pos()

  const scroller = page.locator('.hud-panel').filter({ has: list }).locator('[data-panel-body]')
  const metrics = await scroller.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight }))
  expect(metrics.sh).toBeGreaterThan(metrics.ch)
  await list.getByRole('listitem').first().hover()
  await page.mouse.wheel(0, 1500)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)

  expect(await pos()).toEqual(before)
  const doc = await page.evaluate(() => ({
    top: document.scrollingElement?.scrollTop ?? 0,
    over: document.documentElement.scrollHeight - document.documentElement.clientHeight
  }))
  expect(doc).toEqual({ top: 0, over: 0 })
})

test('2.7 a note longer than the editor scrolls inside the editor only', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  const notes = await sectionId(page, 'Shop', 'notes')
  const id = await seedNote(page, notes, 'Long note')
  const read = await page.evaluate((itemId) => window.harness.invoke('items:read', { itemId }), id)
  if (!read.ok || read.data.type !== 'text') throw new Error('items:read failed')
  const body = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n')
  const saved = await page.evaluate((a) => window.harness.invoke('items:save', a), {
    itemId: id,
    content: body,
    baseRevision: read.data.revision
  })
  expect(saved.ok).toBe(true)
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: /Long note/ }).click()
  await expect(page.locator('.cm-content')).toContainText('line 0')

  const header = (await page.getByRole('heading', { name: 'Shop', level: 2 }).boundingBox())!.y
  const listPanel = page
    .locator('.hud-panel')
    .filter({ has: page.getByRole('list', { name: 'Items' }) })
    .locator('[data-panel-body]')
  const m = await page.locator('.cm-scroller').evaluate((el) => ({
    sh: el.scrollHeight,
    ch: el.clientHeight
  }))
  expect(m.sh).toBeGreaterThan(m.ch)

  await page.locator('.cm-content').hover()
  await page.mouse.wheel(0, 2000)
  await expect
    .poll(() => page.locator('.cm-scroller').evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0)
  expect(await listPanel.evaluate((el) => el.scrollTop)).toBe(0)
  expect((await page.getByRole('heading', { name: 'Shop', level: 2 }).boundingBox())!.y).toBe(
    header
  )
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0)
})

test('2.7 the window cannot be resized below 1100 by 720', async ({ app, window: page }) => {
  await expect(page.getByRole('heading', { name: 'Arc' })).toBeVisible()
  const size = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    w.setSize(500, 300)
    await new Promise((r) => setTimeout(r, 200))
    return w.getSize()
  })
  expect(size[0]).toBeGreaterThanOrEqual(1100)
  expect(size[1]).toBeGreaterThanOrEqual(720)
})

test('2.8 the Markdown preview shows display headings, monospace code on a darker panel and cyan links', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  const notes = await sectionId(page, 'Shop', 'notes')
  const id = await seedNote(page, notes, 'Styled')
  const read = await page.evaluate((itemId) => window.harness.invoke('items:read', { itemId }), id)
  if (!read.ok || read.data.type !== 'text') throw new Error('items:read failed')
  const md = '# Title here\n\n```\nconst x = 1\n```\n\n[docs](https://example.com)\n'
  const saved = await page.evaluate((a) => window.harness.invoke('items:save', a), {
    itemId: id,
    content: md,
    baseRevision: read.data.revision
  })
  expect(saved.ok).toBe(true)
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: /Styled/ }).click()
  await page.getByRole('button', { name: 'Preview' }).click()

  const preview = page.locator('.markdown-preview')
  const heading = preview.getByRole('heading', { name: 'Title here', level: 1 })
  expect(await css(heading, 'font-family')).toContain('Orbitron')
  const pre = preview.locator('pre')
  expect(await css(pre.locator('code'), 'font-family')).toContain('JetBrains Mono')
  expect(await css(pre, 'background-color')).toBe('rgb(2, 6, 9)')
  expect(await css(preview.getByRole('link', { name: 'docs' }), 'color')).toBe(CYAN)
})
