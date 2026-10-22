import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function tempFolder(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'harness-unlui-')))
}

async function newGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Notes' }).click()
}

async function addNote(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Note' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Note' })
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('list', { name: 'Items' }).getByText(title)).toBeVisible()
}

async function queueFolder(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(
    (_e, p) => {
      ;(
        globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
      ).__e2e.queueOpenDialog(p)
    },
    [path]
  )
}

/** Links `folder` to the open group; with `keepAside` the folder replaces the in-app knowledge. */
async function link(
  app: ElectronApplication,
  page: Page,
  folder: string,
  keepAside = false
): Promise<void> {
  await queueFolder(app, folder)
  await page.getByRole('button', { name: 'Link folder…' }).click()
  const dialog = page.getByRole('dialog')
  if (await dialog.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (keepAside) await dialog.getByLabel(/Use the folder's contents only/).check()
    await dialog.getByRole('button', { name: 'Link folder' }).click()
    await expect(dialog).toBeHidden()
  }
  await expect(
    page.getByRole('region', { name: 'Knowledge storage' }).getByText(folder)
  ).toBeVisible()
}

test('Unlink: shows "Stored in app", keeps the same items, leaves the folder alone', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Alpha.md'), 'alpha')
    await writeFile(join(folder, 'Notes', 'Beta.md'), 'beta')
    await newGroup(page, 'Shop')
    await link(app, page, folder)
    const panel = page.getByRole('region', { name: 'Knowledge storage' })
    await panel.getByRole('button', { name: 'Unlink folder' }).click()
    const dialog = page.getByRole('dialog', { name: 'Unlink folder' })
    await expect(dialog.getByRole('radio')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Unlink folder' }).click()
    await expect(dialog).toBeHidden()
    await expect(panel.getByText('Stored in app')).toBeVisible()
    const items = page.getByRole('list', { name: 'Items' })
    await expect(items.getByRole('listitem')).toHaveCount(2)
    expect((await readdir(join(folder, 'Notes'))).sort()).toEqual(['Alpha.md', 'Beta.md'])
    expect(await readFile(join(folder, 'Notes', 'Alpha.md'), 'utf8')).toBe('alpha')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('Unlink with Restore brings back the 2 original in-app notes', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Only.md'), 'only')
    await newGroup(page, 'Shop')
    await addNote(page, 'Alpha')
    await addNote(page, 'Beta')
    await link(app, page, folder, true)
    const items = page.getByRole('list', { name: 'Items' })
    await expect(items.getByRole('listitem')).toHaveCount(1)

    const panel = page.getByRole('region', { name: 'Knowledge storage' })
    await panel.getByRole('button', { name: 'Unlink folder' }).click()
    const dialog = page.getByRole('dialog', { name: 'Unlink folder' })
    await expect(dialog.getByText(/is discarded/)).toBeVisible()
    await dialog.getByLabel(/Restore earlier in-app knowledge/).check()
    await dialog.getByRole('button', { name: 'Unlink folder' }).click()
    await expect(dialog).toBeHidden()
    await expect(panel.getByText('Stored in app')).toBeVisible()
    await expect(items.getByRole('listitem')).toHaveCount(2)
    await expect(items.getByText('Alpha')).toBeVisible()
    await expect(items.getByText('Beta')).toBeVisible()
    expect(await readdir(join(folder, 'Notes'))).toEqual(['Only.md'])
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('A renamed folder shows the banner; Locate recovers; Use app storage gives up', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  const moved = `${folder}-renamed`
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Alpha.md'), 'alpha')
    await newGroup(page, 'Shop')
    await link(app, page, folder)
    await rename(folder, moved)
    // Selecting the group again runs an availability check (so do focus and a 30 s timer).
    await page.getByRole('button', { name: 'New Group' }).click()
    await page.getByLabel('Group name').fill('Other')
    await page.getByRole('button', { name: 'Create' }).click()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()

    const banner = page.getByRole('alert').filter({ hasText: 'Knowledge folder not found' })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner.getByRole('button', { name: 'Locate…' })).toBeVisible()
    await expect(banner.getByRole('button', { name: 'Use app storage' })).toBeVisible()
    for (const tab of await page.getByRole('tab').all()) await expect(tab).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Add Section' })).toBeDisabled()

    await queueFolder(app, moved)
    await banner.getByRole('button', { name: 'Locate…' }).click()
    await expect(banner).toBeHidden()
    await expect(page.getByRole('tab', { name: 'Notes' })).toBeEnabled()
    await page.getByRole('tab', { name: 'Notes' }).click()
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Alpha')).toBeVisible()

    // Gone again, this time give up on it: nothing was kept aside, so it starts empty.
    const gone = `${moved}-gone`
    await rename(moved, gone)
    await page.getByRole('button', { name: 'Other', exact: true }).click()
    await page.getByRole('button', { name: 'Shop', exact: true }).click()
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await banner.getByRole('button', { name: 'Use app storage' }).click()
    const dialog = page.getByRole('dialog', { name: 'Use app storage' })
    await expect(dialog.getByText(/start with empty knowledge/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Use app storage' }).click()
    await expect(dialog).toBeHidden()
    await expect(
      page.getByRole('region', { name: 'Knowledge storage' }).getByText('Stored in app')
    ).toBeVisible()
    await expect(banner).toBeHidden()
    expect(await readdir(join(gone, 'Notes'))).toEqual(['Alpha.md'])
    await rm(gone, { recursive: true, force: true })
  } finally {
    await rm(folder, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  }
})
