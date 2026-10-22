import { expect, test } from './fixtures'

test('the main window is created off-screen, unfocused, and still renders', async ({
  app,
  window
}) => {
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible()))
    .toBe(true)
  const bounds = await app.evaluate(({ BrowserWindow, screen }) => {
    const w = BrowserWindow.getAllWindows()[0]!
    return {
      bounds: w.getBounds(),
      visible: w.isVisible(),
      focused: w.isFocused(),
      displays: screen.getAllDisplays().map((d) => d.bounds)
    }
  })
  console.log('E2E window bounds', JSON.stringify(bounds))
  const onAny = bounds.displays.some(
    (d) =>
      bounds.bounds.x < d.x + d.width &&
      bounds.bounds.x + bounds.bounds.width > d.x &&
      bounds.bounds.y < d.y + d.height &&
      bounds.bounds.y + bounds.bounds.height > d.y
  )
  expect(onAny).toBe(false)
  expect(bounds.visible).toBe(true)
  expect(bounds.focused).toBe(false)
  expect(bounds.bounds.width).toBe(1200)
  const shot = await window.screenshot()
  expect(shot.byteLength).toBeGreaterThan(1000)
})
