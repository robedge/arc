import { expect, test } from './fixtures'

test('launches with an isolated user-data folder', async ({ app, window, userDataDir }) => {
  await expect(window.getByRole('heading', { name: 'Arc' })).toBeVisible()
  const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  // macOS tmpdir may be a symlink (/var -> /private/var), so compare real paths
  const { realpath } = await import('node:fs/promises')
  expect(await realpath(userData)).toBe(await realpath(userDataDir))
})
