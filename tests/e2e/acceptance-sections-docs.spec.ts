// @spec: 001-groups-and-knowledge-sections
// @regression
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function queue(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

async function newGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name })).toBeVisible()
}

test('2.3 duplicate section names are refused and deleting a section states its item count', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  const dialog = page.getByRole('dialog')
  const tabs = page.getByRole('tablist', { name: 'Sections' }).getByRole('tab')

  await page.getByRole('button', { name: 'Add Section' }).click()
  await dialog.getByLabel('Section name').fill('Runbooks')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(tabs.last()).toHaveText('Runbooks')

  for (const dup of ['runbooks', 'Docs']) {
    await page.getByRole('button', { name: 'Add Section' }).click()
    await dialog.getByLabel('Section name').fill(dup)
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await expect(dialog.getByRole('alert')).toHaveText(
      'A section with this name already exists in this group.'
    )
    await dialog.getByRole('button', { name: 'Cancel' }).click()
  }
  await expect(tabs).toHaveCount(7)

  await tabs.last().click()
  for (const title of ['One', 'Two', 'Three']) {
    await page.getByRole('button', { name: 'New Item', exact: true }).click()
    await dialog.getByLabel('Title', { exact: true }).fill(title)
    await dialog.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('list', { name: 'Items' }).getByText(title)).toBeVisible()
  }

  await page.getByRole('button', { name: 'Section options' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(page.getByText("Delete 'Runbooks' and its 3 items?")).toBeVisible()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(tabs).toHaveCount(7)
  await page.getByRole('button', { name: 'Section options' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(tabs).toHaveCount(6)
})

test('2.4 a title is required and a deleted note disappears only after confirming', async ({
  window: page
}) => {
  await newGroup(page, 'Shop')
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'New Note' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Title', { exact: true }).fill('')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Title is required.')
  await dialog.getByLabel('Title', { exact: true }).fill('Service map')
  await dialog.getByRole('button', { name: 'Create' }).click()

  const list = page.getByRole('list', { name: 'Items' })
  await expect(list.getByText('Service map')).toBeVisible()

  await page.getByLabel('Title', { exact: true }).fill('')
  await page.getByLabel('Title', { exact: true }).blur()
  await expect(page.getByText('Title is required.')).toBeVisible()
  await page.getByLabel('Title', { exact: true }).fill('Service map')
  await page.getByLabel('Title', { exact: true }).blur()

  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(list.getByText('Service map')).toBeVisible()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(list.getByText('Service map')).toHaveCount(0)
})

test('2.5 mixed import: valid files added, oversized and unsupported named, originals untouched, Replace overwrites', async ({
  app,
  window: page
}) => {
  const src = await mkdtemp(join(tmpdir(), 'harness-accdocs-'))
  const sha = async (p: string): Promise<string> =>
    createHash('sha256')
      .update(await readFile(p))
      .digest('hex')
  try {
    const sql = join(src, 'orders_schema.sql')
    const json = join(src, 'api.json')
    const yaml = join(src, 'api.yaml')
    const big = join(src, 'big_dump.sql')
    const exe = join(src, 'setup.exe')
    await writeFile(sql, 'CREATE TABLE orders (id int);\n')
    await writeFile(json, '{"a":1}\n')
    await writeFile(yaml, 'a: 1\n')
    await writeFile(big, '')
    await truncate(big, 20 * 1024 * 1024 + 1)
    await writeFile(exe, 'MZ')
    const originals = new Map<string, string>()
    for (const p of [sql, json, yaml, big, exe]) originals.set(p, await sha(p))

    await newGroup(page, 'Shop')
    await page.getByRole('tab', { name: 'Docs' }).click()
    await queue(app, [sql, json, yaml, big, exe])
    await page.getByRole('button', { name: 'Import…' }).click()

    const list = page.getByRole('list', { name: 'Items' })
    for (const n of ['orders_schema.sql', 'api.json', 'api.yaml'])
      await expect(list.getByText(n, { exact: true })).toBeVisible()
    await expect(list.getByText('big_dump.sql')).toHaveCount(0)
    await expect(list.getByText('setup.exe')).toHaveCount(0)
    const toasts = page.getByRole('status')
    await expect(toasts).toContainText("'big_dump.sql' is larger than 20 MB and was not added.")
    await expect(toasts).toContainText("'setup.exe' isn't a supported file type.")

    for (const [p, h] of originals) expect(await sha(p)).toBe(h)

    await writeFile(sql, 'CREATE TABLE orders (id int, total int);\n')
    await queue(app, [sql])
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(page.getByText("'orders_schema.sql' already exists in Docs.")).toBeVisible()
    await page.getByRole('button', { name: 'Replace' }).click()
    await expect(list.getByText('orders_schema (2).sql')).toHaveCount(0)
    await list.getByRole('button', { name: /orders_schema/ }).click()
    await expect(page.locator('.cm-content')).toContainText('total int')
  } finally {
    await rm(src, { recursive: true, force: true })
  }
})
