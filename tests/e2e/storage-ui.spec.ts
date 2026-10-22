import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function tempFolder(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), 'harness-storui-')))
}

async function newGroup(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(name)
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Notes' }).click()
}

async function addNote(page: Page, title: string, text?: string): Promise<void> {
  await page.getByRole('button', { name: 'New Note' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Note' })
  await dialog.getByLabel('Title').fill(title)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('list', { name: 'Items' }).getByText(title)).toBeVisible()
  if (text) {
    await page.locator('.cm-content').click()
    await page.keyboard.type(text)
    await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 3000 })
  }
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

test('a new group shows "Stored in app"', async ({ window: page }) => {
  await newGroup(page, 'Shop')
  const panel = page.getByRole('region', { name: 'Knowledge storage' })
  await expect(panel.getByText('Stored in app')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Link folder…' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Show in Finder' })).toBeVisible()
})

test('Move into an empty folder: Notes/ holds 2 files and the app shows 2 notes', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  try {
    await newGroup(page, 'Shop')
    await addNote(page, 'Alpha', 'alpha text')
    await addNote(page, 'Beta', 'beta text')

    await queueFolder(app, folder)
    const panel = page.getByRole('region', { name: 'Knowledge storage' })
    await panel.getByRole('button', { name: 'Link folder…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText(/nothing is overwritten/)).toBeVisible()
    await expect(dialog.getByText(/kept aside/)).toBeVisible()
    await dialog.getByLabel(/Move existing knowledge here/).check()
    await dialog.getByRole('button', { name: 'Link folder' }).click()

    await expect(dialog).toBeHidden()
    await expect(panel.getByText(folder)).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Link folder…' })).toHaveCount(0)
    expect((await readdir(join(folder, 'Notes'))).filter((f) => f.endsWith('.md')).sort()).toEqual([
      'Alpha.md',
      'Beta.md'
    ])
    const items = page.getByRole('list', { name: 'Items' })
    await expect(items.getByText('Alpha')).toBeVisible()
    await expect(items.getByText('Beta')).toBeVisible()
    await expect(items.getByRole('listitem')).toHaveCount(2)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('Move keeps both "Service map" and "Service map (2)" with their text', async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Service map.md'), 'folder text')
    await newGroup(page, 'Shop')
    await addNote(page, 'Service map', 'app text')

    await queueFolder(app, folder)
    await page.getByRole('button', { name: 'Link folder…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Link folder' }).click()

    const items = page.getByRole('list', { name: 'Items' })
    await expect(items.getByText('Service map (2)')).toBeVisible()
    await expect(items.getByText('Service map', { exact: true })).toBeVisible()
    expect(await readFile(join(folder, 'Notes', 'Service map.md'), 'utf8')).toBe('folder text')
    expect(await readFile(join(folder, 'Notes', 'Service map (2).md'), 'utf8')).toBe('app text')
    await page.getByRole('button', { name: /Service map \(2\)/ }).click()
    await expect(page.locator('.cm-content')).toContainText('app text')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("Use the folder's contents only shows just the folder's 5 notes", async ({
  app,
  window: page
}) => {
  const folder = await tempFolder()
  try {
    await mkdir(join(folder, 'Notes'))
    for (const n of ['One', 'Two', 'Three', 'Four', 'Five']) {
      await writeFile(join(folder, 'Notes', `${n}.md`), `${n} text`)
    }
    await newGroup(page, 'Shop')
    await addNote(page, 'Alpha')
    await addNote(page, 'Beta')

    await queueFolder(app, folder)
    await page.getByRole('button', { name: 'Link folder…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel(/Use the folder's contents only/).check()
    await dialog.getByRole('button', { name: 'Link folder' }).click()
    await expect(dialog).toBeHidden()

    const rows = page.getByRole('list', { name: 'Items' }).getByRole('listitem')
    await expect(rows).toHaveCount(5)
    await expect(page.getByRole('list', { name: 'Items' }).getByText('Alpha')).toHaveCount(0)
    await expect(
      page.getByRole('region', { name: 'Knowledge storage' }).getByText(/kept aside/)
    ).toBeVisible()
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('a folder that cannot be linked shows a message and links nothing', async ({
  app,
  window: page,
  userDataDir
}) => {
  await newGroup(page, 'Shop')
  await queueFolder(app, userDataDir)
  await page.getByRole('button', { name: 'Link folder…' }).click()
  await expect(page.getByRole('alert')).toContainText('Choose a different folder.')
  await expect(page.getByRole('region', { name: 'Knowledge storage' })).toContainText(
    'Stored in app'
  )
})
