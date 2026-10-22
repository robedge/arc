import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function clickPreviewItem(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('help-design-preview')?.click()
  })
}

async function openPreview(app: ElectronApplication): Promise<Page> {
  await clickPreviewItem(app)
  await expect.poll(() => app.windows().length).toBe(2)
  const page = app.windows().find((w) => w.url().endsWith('/preview.html'))
  if (!page) throw new Error('preview window not found')
  await page.waitForLoadState('domcontentloaded')
  return page
}

test('Help > Design Preview opens one preview; a second click keeps two windows', async ({
  app,
  window: main
}) => {
  const preview = await openPreview(app)
  await expect(preview.getByRole('heading', { name: 'Design Preview' })).toBeVisible()
  await clickPreviewItem(app)
  await clickPreviewItem(app)
  await main.waitForTimeout(300)
  expect(app.windows()).toHaveLength(2)
})

test('the preview has no preload bridge', async ({ app, window: main }) => {
  await main.waitForLoadState('domcontentloaded')
  const preview = await openPreview(app)
  expect(await preview.evaluate(() => typeof (window as { harness?: unknown }).harness)).toBe(
    'undefined'
  )
})

test('closing the preview keeps the app running; quitting with both open exits promptly', async ({
  app,
  window: main
}) => {
  const preview = await openPreview(app)
  await preview.close()
  await expect.poll(() => app.windows().length).toBe(1)
  expect(await main.evaluate(() => typeof (window as { harness?: unknown }).harness)).toBe('object')

  await openPreview(app)
  let stderr = ''
  app.process().stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()))
  const start = Date.now()
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await exited
  const elapsed = Date.now() - start
  test.info().annotations.push({ type: 'quit-ms', description: String(elapsed) })
  console.log(`quit-ms=${elapsed}`)
  // The meaningful property: the renderer answered the close handshake, so the 2 s gate
  // timeout never released the quit. Wall-clock time only reflects machine load, so it is
  // just a hang guard well above the gate timeout.
  expect(stderr).not.toContain('[close-gate] timed out')
  expect(elapsed).toBeLessThan(6000)
})

test('select-all, cut and paste work through the Edit roles', async ({ app, window: page }) => {
  await page.getByRole('button', { name: 'New Group' }).click()
  const name = page.getByLabel('Group name')
  await name.fill('hello')
  await name.focus()
  // Real key presses: the Edit menu accelerators (CmdOrCtrl+A/X/V) must be live.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus())
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  const click = (key: string): Promise<void> => page.keyboard.press(`${mod}+${key}`)
  await click('a')
  await click('x')
  await expect(name).toHaveValue('')
  await click('v')
  await expect(name).toHaveValue('hello')
})
