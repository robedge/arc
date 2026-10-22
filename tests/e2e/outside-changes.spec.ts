import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

async function knowledgeRoot(userDataDir: string): Promise<string> {
  const groups = join(userDataDir, 'groups')
  const ids = await readdir(groups)
  return join(groups, ids[0] ?? '', 'knowledge')
}

async function createNote(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill('Shop')
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByLabel('Title', { exact: true }).fill(title)
  await page.getByRole('button', { name: 'Create' }).click()
}

test('outside edits: clean editor reloads, new Docs file appears, dirty editor keeps text', async ({
  window: page,
  userDataDir
}) => {
  await createNote(page, 'Service map')
  await page.locator('.cm-content').click()
  await page.keyboard.type('first')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })
  const root = await knowledgeRoot(userDataDir)
  const notePath = join(root, 'Notes', 'Service map.md')

  // Clean editor: the new disk text is shown within 5 s, with no banner.
  await writeFile(notePath, '# From Finder\n')
  await expect(page.locator('.cm-content')).toContainText('From Finder', { timeout: 5000 })
  await expect(page.getByRole('button', { name: 'Keep mine' })).toHaveCount(0)

  // Dirty editor: typing then an outside change shows the banner and keeps the typed text.
  await page.locator('.cm-content').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' typed-locally')
  await writeFile(notePath, '# Changed again outside\n')
  await expect(page.getByRole('button', { name: 'Keep mine' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cm-content')).toContainText('typed-locally')
  await expect(page.locator('.cm-content')).not.toContainText('Changed again outside')

  // Keep mine resumes autosave and overwrites the disk copy.
  await page.getByRole('button', { name: 'Keep mine' }).click()
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 3000 })
  await expect(page.getByRole('button', { name: 'Keep mine' })).toHaveCount(0)

  // A new Markdown file in Docs/ shows up in the Docs section.
  await page.getByRole('tab', { name: 'Docs' }).click()
  await writeFile(join(root, 'Docs', 'runbook.md'), '# Runbook\n')
  await expect(page.getByRole('list', { name: 'Items' }).getByText('runbook')).toBeVisible({
    timeout: 5000
  })
})

test('deleting the open note on disk offers Save as new and Close', async ({
  window: page,
  userDataDir
}) => {
  await createNote(page, 'Gone soon')
  await page.locator('.cm-content').click()
  await page.keyboard.type('precious text')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })
  const root = await knowledgeRoot(userDataDir)
  await rm(join(root, 'Notes', 'Gone soon.md'))
  await expect(page.getByRole('button', { name: 'Save as new' })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: 'Save as new' }).click()
  await expect(page.getByRole('button', { name: 'Save as new' })).toHaveCount(0)
  await expect(page.locator('.cm-content')).toContainText('precious text')
})

test('Show in Finder records the resolved reveal path', async ({
  app,
  window: page,
  userDataDir
}) => {
  await createNote(page, 'Service map')
  await page.getByRole('button', { name: 'Show in Finder' }).first().click()
  const root = await knowledgeRoot(userDataDir)
  await expect
    .poll(async () => {
      const calls = await app.evaluate(() =>
        (
          globalThis as unknown as { __e2e: { getShellCalls(): { kind: string; path?: string }[] } }
        ).__e2e.getShellCalls()
      )
      return calls.filter((c) => c.kind === 'reveal').map((c) => c.path)
    })
    .toEqual([root])
})

test('leaving a conflicted note asks first; Keep mine writes the local text to disk', async ({
  window: page,
  userDataDir
}) => {
  await createNote(page, 'First')
  await page.getByRole('button', { name: 'New Note' }).click()
  await page.getByRole('dialog').getByLabel('Title').fill('Second')
  await page.getByRole('button', { name: 'Create' }).click()
  const items = page.getByRole('list', { name: 'Items' })
  await items.getByText('First').click()
  await page.locator('.cm-content').click()
  await page.keyboard.type('base')
  await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 2000 })
  const notePath = join(await knowledgeRoot(userDataDir), 'Notes', 'First.md')

  await page.keyboard.type(' typed-locally')
  await writeFile(notePath, 'from the outside\n')
  await expect(page.getByRole('button', { name: 'Keep mine' })).toBeVisible({ timeout: 5000 })

  await items.getByText('Second').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('unsaved changes to First that conflict with the file on disk')
  await dialog.getByRole('button', { name: 'Keep mine' }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(() => readFile(notePath, 'utf8')).toContain('typed-locally')
})
