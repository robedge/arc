import { expect, test } from './fixtures'
import type { ElectronApplication, Page } from '@playwright/test'

/** The web page viewport must always equal the window content area (no black band). */
async function expectViewportFillsWindow(app: ElectronApplication, page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const content = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0]!.getContentBounds()
      )
      const size = await page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        titleBarWidth: document.querySelector('header')?.getBoundingClientRect().width ?? 0
      }))
      return {
        match: size.width === content.width && size.height === content.height,
        titleBarFull: Math.round(size.titleBarWidth) === content.width
      }
    })
    .toEqual({ match: true, titleBarFull: true })
}

test('page viewport and title bar fill the window after resize, maximize and fullscreen', async ({
  app,
  window
}) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible()
  await expectViewportFillsWindow(app, window)

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setBounds({ x: 40, y: 40, width: 1400, height: 900 })
  )
  await expectViewportFillsWindow(app, window)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.maximize())
  await expectViewportFillsWindow(app, window)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.unmaximize())
  await expectViewportFillsWindow(app, window)

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(true))
  await expectViewportFillsWindow(app, window)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setFullScreen(false))
  await expectViewportFillsWindow(app, window)
})
