import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('a renamed project folder shows Folder not found and Locate restores it', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-missing-')))
  try {
    const original = join(root, 'alpha')
    const moved = join(root, 'alpha-moved')
    await mkdir(original)
    const queue = (p: string): Promise<void> =>
      app.evaluate((_e, path) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog([path])
      }, p)

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('tab', { name: 'Projects' }).click()
    await queue(original)
    await page.getByRole('button', { name: 'Add Project' }).click()
    const rows = page.getByRole('list', { name: 'Projects' }).getByRole('listitem')
    await expect(rows.filter({ hasText: original })).toHaveCount(1)

    const focus = (): Promise<void> =>
      app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.emit('focus')
      })
    await rename(original, moved)
    await focus()
    await expect(page.getByText('Folder not found')).toBeVisible()

    await queue(moved)
    await page.getByRole('button', { name: 'Locate…' }).click()
    await expect(rows.filter({ hasText: moved })).toHaveCount(1)
    await expect(page.getByText('Folder not found')).toHaveCount(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
