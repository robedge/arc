import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('app:ping returns the app version', async ({ app, window: page }) => {
  const version = await app.evaluate(({ app: a }) => a.getVersion())
  const res = await page.evaluate(() => window.harness.invoke('app:ping', {}))
  expect(res).toEqual({ ok: true, data: expect.objectContaining({ version }) })
})

test('window.open from the renderer is denied', async ({ app, window: page }) => {
  const result = await page.evaluate(() => window.open('https://example.com') === null)
  expect(result).toBe(true)
  await page.waitForTimeout(500)
  expect(app.windows()).toHaveLength(1)
})

test('E2E dialog hook is available in main', async ({ app, window }) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible() // wait for the window to exist

  const calls = await app.evaluate(() => {
    const e2e = (
      globalThis as unknown as {
        __e2e: { queueOpenDialog(p: string[] | null): void; getDialogCalls(): unknown[] }
      }
    ).__e2e
    e2e.queueOpenDialog(['/x'])
    return e2e.getDialogCalls()
  })
  expect(calls).toEqual([])
})

test('renderer is isolated and sandboxed', async ({ app, window }) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible() // wait for the window to exist

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>
    }
    const p = wc.getLastWebPreferences()
    return {
      contextIsolation: p.contextIsolation,
      sandbox: p.sandbox,
      nodeIntegration: p.nodeIntegration
    }
  })
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false })
})

test('window enforces HUD size, ground color and dark theme', async ({ app, window }) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible()
  const info = await app.evaluate(({ BrowserWindow, nativeTheme }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    return {
      min: w.getMinimumSize(),
      bg: w.getBackgroundColor().toLowerCase(),
      dark: nativeTheme.shouldUseDarkColors
    }
  })
  expect(info.min).toEqual([1100, 720])
  expect(info.bg).toBe('#03080f')
  expect(info.dark).toBe(true)
})

test('title bar spans the window, sits above every panel, drags, and leaves the sidebar clickable', async ({
  window
}) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible()
  const bar = window.locator('[data-titlebar]')
  const box = (await bar.boundingBox())!
  const width = await window.evaluate(() => document.documentElement.clientWidth)
  expect(box.x).toBe(0)
  expect(box.y).toBe(0)
  expect(box.width).toBe(width)
  expect(box.height).toBe(40)
  const tops = await window
    .locator('.hud-panel')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top))
  expect(tops.length).toBeGreaterThan(0)
  for (const top of tops) expect(box.y + box.height).toBeLessThanOrEqual(top)
  await expect(bar).toHaveCSS('-webkit-app-region', 'drag')
  const newGroup = window.getByRole('button', { name: 'New Group' })
  await newGroup.click({ trial: true })
  await newGroup.click()
  await expect(window.getByRole('dialog')).toBeVisible()
  await expect(window.getByRole('dialog')).toHaveCSS('-webkit-app-region', 'no-drag')
})
