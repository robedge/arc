import { mkdir, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function tempFolder(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

async function queue(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

async function walk(root: string, dir = root): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(root, full)))
    else out.push(relative(root, full))
  }
  return out.sort()
}

/** Name, size and mtime of every file, so any touch of a folder shows up as a difference. */
async function fingerprint(root: string): Promise<string[]> {
  const files = await walk(root)
  return Promise.all(
    files.map(async (f) => {
      const s = await stat(join(root, f))
      return `${f}|${s.size}|${s.mtimeMs}`
    })
  )
}

async function newGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
}

async function openDelete(page: Page): Promise<void> {
  const nav = page.getByRole('navigation', { name: 'Groups' })
  await nav.getByRole('button', { name: 'Group options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Group' }).click()
}

test('Export knowledge first saves notes, docs, links and custom sections, then Delete removes the group', async ({
  app,
  window: page
}) => {
  const src = await tempFolder('harness-exp-src-')
  const dest = await tempFolder('harness-exp-dest-')
  try {
    const schema = join(src, 'orders_schema.sql')
    await writeFile(schema, 'CREATE TABLE orders (id int);\n')
    await newGroup(page, 'Shop')

    await page.getByRole('tab', { name: 'Notes' }).click()
    await page.getByRole('button', { name: 'New Note' }).click()
    await page.getByRole('dialog').getByLabel('Title').fill('Kickoff')
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Kickoff')).toBeVisible()

    await page.getByRole('tab', { name: 'Docs' }).click()
    await queue(app, [schema])
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(
      page.getByRole('list', { name: 'Items' }).getByText('orders_schema.sql', { exact: true })
    ).toBeVisible()

    await page.getByRole('tab', { name: 'Links' }).click()
    await page.getByRole('button', { name: 'Add Link' }).click()
    await page.getByRole('dialog').getByLabel('Address').fill('https://wiki.example.com/orders')
    await page.getByRole('dialog').getByLabel('Title (optional)').fill('Orders wiki')
    await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
    await expect(page.getByRole('list', { name: 'Links' }).getByText('Orders wiki')).toBeVisible()

    await page.getByRole('button', { name: 'Add Section' }).click()
    await page.getByLabel('Section name').fill('Runbooks')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('tab', { name: 'Runbooks' }).click()
    await page.getByRole('button', { name: 'New Item' }).click()
    await page.getByRole('dialog').getByLabel('Title').fill('Rollback')
    await page.getByRole('dialog').getByRole('button', { name: 'Create' }).click()
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Rollback')).toBeVisible()

    await openDelete(page)
    const dialog = page.getByRole('dialog', { name: 'Delete Group' })

    // A cancelled picker leaves the dialog as it was.
    await dialog.getByRole('button', { name: 'Export knowledge first' }).click()
    await expect(dialog.getByRole('button', { name: 'Export knowledge first' })).toBeEnabled()
    await expect(dialog.getByText(/Exported/)).toHaveCount(0)

    await queue(app, [dest])
    await dialog.getByRole('button', { name: 'Export knowledge first' }).click()
    await expect(dialog.getByText(/^Exported \d+ files? to /)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled()

    const exported = join(dest, 'Shop-knowledge')
    const files = await walk(exported)
    expect(files.some((f) => f.includes('Kickoff'))).toBe(true)
    expect(files.some((f) => f.includes('orders_schema.sql'))).toBe(true)
    expect(files.some((f) => f.includes('Orders wiki') || f.toLowerCase().includes('link'))).toBe(
      true
    )
    expect(files.some((f) => f.includes('Rollback'))).toBe(true)
    expect(files.some((f) => f.startsWith('.arc'))).toBe(true)
    console.log('EXPORTED FILES:', JSON.stringify(files))

    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Create a group to get started.')).toBeVisible()
  } finally {
    await rm(src, { recursive: true, force: true })
    await rm(dest, { recursive: true, force: true })
  }
})

test('Deleting a linked group states the folder is kept and leaves it untouched', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder('harness-exp-linked-')
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Alpha.md'), 'alpha')
    await writeFile(join(folder, 'Notes', 'Beta.md'), 'beta body')
    await newGroup(page, 'Shop')
    await queue(app, [folder])
    await page.getByRole('button', { name: 'Link folder…' }).click()
    const link = page.getByRole('dialog')
    if (await link.isVisible({ timeout: 1000 }).catch(() => false)) {
      await link.getByRole('button', { name: 'Link folder' }).click()
    }
    await expect(
      page.getByRole('region', { name: 'Knowledge storage' }).getByText(folder)
    ).toBeVisible()
    const before = await fingerprint(folder)

    await openDelete(page)
    const dialog = page.getByRole('dialog', { name: 'Delete Group' })
    await expect(dialog.getByText(/linked knowledge folder will not be deleted/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Export knowledge first' })).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(page.getByText('Create a group to get started.')).toBeVisible()

    expect(await fingerprint(folder)).toEqual(before)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
