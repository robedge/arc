// SPIKE (A2UI), throwaway: a screenshot of the surface in the Design Preview.
import { expect, mainWindow, test } from './fixtures'

test('surface spike screenshot', async ({ app }, testInfo) => {
  await mainWindow(app)
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('help-design-preview')?.click()
  })
  await expect.poll(() => app.windows().length).toBe(2)
  const page = app.windows().find((w) => w.url().endsWith('/preview.html'))
  if (!page) throw new Error('preview window not found')
  const bubble = page.locator('[data-message-role]:has([data-surface])')
  await bubble.scrollIntoViewIfNeeded()
  await bubble.screenshot({ path: testInfo.outputPath('surface.png') })
})
