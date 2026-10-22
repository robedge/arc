// @spec: 001-groups-and-knowledge-sections
// @regression
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
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

async function digest(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const name of (await readdir(dir)).sort()) {
    out[name] = createHash('sha256')
      .update(await readFile(join(dir, name)))
      .digest('hex')
  }
  return out
}

test('2.1 group name rules: empty, duplicate ignoring case, and 61 characters create nothing', async ({
  window: page
}) => {
  const nav = page.getByRole('navigation', { name: 'Groups' })
  const dialog = page.getByRole('dialog')

  await page.getByRole('button', { name: 'New Group' }).click()
  await dialog.getByLabel('Group name').fill('Storefront')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(nav.getByText('Storefront')).toBeVisible()

  await page.getByRole('button', { name: 'New Group' }).click()
  await dialog.getByLabel('Group name').fill('')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Group name is required.')

  await dialog.getByLabel('Group name').fill('storefront')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('A group with this name already exists.')

  await dialog.getByLabel('Group name').fill('x'.repeat(61))
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Group name must be 60 characters or fewer.')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(nav.getByRole('button', { name: /^(Storefront|storefront|x+)$/ })).toHaveCount(1)
  const listed = await page.evaluate(() => window.harness.invoke('groups:list', {}))
  expect(listed.ok && listed.data.map((g) => g.name)).toEqual(['Storefront'])
})

test('2.1/2.2 rename keeps projects and knowledge; deleting the group leaves project folders unchanged', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-accgrp-')))
  try {
    const proj = join(root, 'api')
    await mkdir(proj)
    await writeFile(join(proj, 'main.ts'), 'export const x = 1\n')
    await writeFile(join(proj, 'README.md'), '# api\n')
    const before = await digest(proj)
    const nav = page.getByRole('navigation', { name: 'Groups' })

    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Storefront')
    await page.getByRole('button', { name: 'Create' }).click()
    await queue(app, [proj])
    await page.getByRole('tab', { name: 'Projects' }).click()
    await page.getByRole('button', { name: 'Add Project' }).click()
    await expect(page.getByRole('list', { name: 'Projects' }).getByText(proj)).toBeVisible()

    await page.getByRole('tab', { name: 'Notes' }).click()
    await page.getByRole('button', { name: 'New Note' }).click()
    await page.getByLabel('Title', { exact: true }).fill('Service map')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Service map')).toBeVisible()

    await nav.getByRole('button', { name: 'Group options' }).click()
    await page.getByRole('menuitem', { name: 'Rename' }).click()
    await page.getByLabel('Group name').fill('Shop')
    await page.getByRole('button', { name: 'Rename' }).click()
    await expect(nav.getByText('Shop')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Shop' })).toBeVisible()
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Service map')).toBeVisible()
    await page.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByRole('list', { name: 'Projects' }).getByText(proj)).toBeVisible()

    await nav.getByRole('button', { name: 'Group options' }).click()
    await page.getByRole('menuitem', { name: 'Delete Group' }).click()
    await expect(page.getByText('Your project folders will not be touched.')).toBeVisible()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(nav.getByText('Shop')).toHaveCount(0)

    expect(await digest(proj)).toEqual(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
