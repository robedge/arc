import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'
import { expect, test } from './fixtures'

async function queue(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

test('import a SQL schema into Docs, edit it, and keep both on conflict', async ({
  app,
  window: page
}) => {
  const src = await mkdtemp(join(tmpdir(), 'harness-e2e-src-'))
  try {
    const schema = join(src, 'orders_schema.sql')
    await writeFile(schema, 'CREATE TABLE orders (id int);\n')

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('tab', { name: 'Docs' }).click()

    await queue(app, [schema])
    await page.getByRole('button', { name: 'Import…' }).click()
    const list = page.getByRole('list', { name: 'Items' })
    await expect(list.getByText('orders_schema.sql', { exact: true })).toBeVisible()

    await list.getByRole('button', { name: /orders_schema/ }).click()
    const editor = page.locator('.cm-content')
    await expect(editor).toContainText('CREATE TABLE orders')
    await editor.click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.type('-- edited')
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })

    await queue(app, [schema])
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(page.getByText("'orders_schema.sql' already exists in Docs.")).toBeVisible()
    await page.getByRole('button', { name: 'Keep Both' }).click()
    await expect(list.getByText('orders_schema (2).sql', { exact: true })).toBeVisible()
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
