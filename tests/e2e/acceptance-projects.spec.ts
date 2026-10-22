// @spec: 001-groups-and-knowledge-sections
// @regression
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
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

test('2.2 duplicate add, shared folder across groups, file rejected, remove keeps the folder', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-accproj-')))
  try {
    const lib = join(root, 'shared-lib')
    await mkdir(lib)
    await writeFile(join(lib, 'index.ts'), 'export {}\n')
    const file = join(root, 'notes.txt')
    await writeFile(file, 'not a folder')
    const nav = page.getByRole('navigation', { name: 'Groups' })
    const rows = page.getByRole('list', { name: 'Projects' }).getByRole('listitem')
    const toast = page.getByRole('status')

    await newGroup(page, 'Storefront')
    await page.getByRole('tab', { name: 'Projects' }).click()
    await queue(app, [lib])
    await page.getByRole('button', { name: 'Add Project' }).click()
    await expect(rows).toHaveCount(1)

    await queue(app, [lib])
    await page.getByRole('button', { name: 'Add Project' }).click()
    await expect(toast.filter({ hasText: 'This folder is already in the group.' })).toHaveCount(1)
    await expect(rows).toHaveCount(1)

    await queue(app, [file])
    await page.getByRole('button', { name: 'Add Project' }).click()
    await expect(toast.filter({ hasText: 'Only folders can be added as projects.' })).toHaveCount(1)
    await expect(rows).toHaveCount(1)

    await newGroup(page, 'Admin')
    await page.getByRole('tab', { name: 'Projects' }).click()
    await queue(app, [lib])
    await page.getByRole('button', { name: 'Add Project' }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.getByText(lib)).toBeVisible()

    await nav.getByRole('button', { name: 'Storefront' }).click()
    await page.getByRole('tab', { name: 'Projects' }).click()
    await expect(rows).toHaveCount(1)
    await expect(rows.getByText(lib)).toBeVisible()

    await rows.getByRole('button', { name: 'Remove project' }).click()
    await page.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(rows).toHaveCount(0)
    expect((await stat(join(lib, 'index.ts'))).isFile()).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// Real OS drag from Finder cannot be automated. Substitute: a synthetic drop event proves the
// window never navigates, and the same projects:add IPC the drop handler calls adds the folder.
test('2.2 dropping onto the window never navigates; projects:add (the drop IPC) adds a folder', async ({
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-accdrop-')))
  try {
    const dir = join(root, 'dropped-repo')
    await mkdir(dir)
    await newGroup(page, 'Storefront')
    const urlBefore = page.url()

    const prevented = await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['x'], 'dragged.txt'))
      const ev = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      document.body.dispatchEvent(ev)
      return ev.defaultPrevented
    })
    expect(prevented).toBe(true)
    expect(page.url()).toBe(urlBefore)
    await expect(page.getByRole('heading', { name: 'Storefront' })).toBeVisible()

    const groups = await page.evaluate(() => window.harness.invoke('groups:list', {}))
    const gid = groups.ok ? groups.data[0]?.id : undefined
    if (!gid) throw new Error('no group')
    const added = await page.evaluate(
      (a) => window.harness.invoke('projects:add', { groupId: a.gid, paths: [a.dir] }),
      { gid, dir }
    )
    expect(added).toMatchObject({ ok: true, data: { added: [{ path: dir }], skipped: [] } })
    const skipped = await page.evaluate(
      (a) => window.harness.invoke('projects:add', { groupId: a.gid, paths: [a.file] }),
      { gid, file: join(root, 'missing.txt') }
    )
    expect(skipped.ok).toBe(true)

    await page.reload()
    await page
      .getByRole('navigation', { name: 'Groups' })
      .getByRole('button', { name: 'Storefront' })
      .click()
    await page.getByRole('tab', { name: 'Projects' }).click()
    await expect(page.getByRole('list', { name: 'Projects' }).getByText(dir)).toBeVisible()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
