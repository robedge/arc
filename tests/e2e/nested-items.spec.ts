import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test('a linked folder section whose files live only in subfolders shows them under group headers', async ({
  app,
  window: page
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'harness-nested-')))
  try {
    await mkdir(join(folder, 'spec', '001-x'), { recursive: true })
    await writeFile(join(folder, 'spec', '001-x', 'a.md'), 'nested text')
    await writeFile(join(folder, 'spec', 'top.md'), 'top text')
    await mkdir(join(folder, 'spec', 'node_modules'), { recursive: true })
    await writeFile(join(folder, 'spec', 'node_modules', 'junk.md'), 'junk')

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await app.evaluate(
      (_e, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [folder]
    )
    await page.getByRole('button', { name: 'Link folder…' }).click()
    // A new, empty group links without asking how to merge.
    await expect(page.getByRole('region', { name: 'Knowledge storage' })).toContainText(folder)

    await page.getByRole('tab', { name: /spec/i }).click()
    const items = page.getByRole('list', { name: 'Items' })
    await expect(items.getByText('top', { exact: true })).toBeVisible()
    const header = page.getByRole('button', { name: '001-x' })
    await expect(header).toHaveAttribute('aria-expanded', 'true')
    await expect(items.getByText('a', { exact: true })).toBeVisible()
    await expect(items.getByText('junk')).toHaveCount(0)

    await items.getByText('a', { exact: true }).click()
    await expect(page.locator('.cm-content')).toContainText('nested text')
    await page.screenshot({ path: 'docs/screenshots/nested-section-items.png' })

    await header.click()
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(items.getByText('a', { exact: true })).toHaveCount(0)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
