import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { Result } from '../../src/shared/errors'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import type { Group } from '../../src/shared/types/group'
import type { ItemSummary } from '../../src/shared/types/item'
import type { Section } from '../../src/shared/types/section'
import type {
  StorageLocateResult,
  StoragePickResult,
  StorageState
} from '../../src/shared/types/storage'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
    __avail?: { groupId: string; knowledgeRoot?: boolean; available: boolean }[]
  }
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`IPC failed: ${result.error.code}`)
  return result.data
}

async function createLinkedGroup(
  page: Page,
  app: Parameters<Parameters<typeof test>[2]>[0]['app'],
  folder: string,
  name: string
): Promise<{ id: string; notesId: string }> {
  const group = data<Group>(
    await page.evaluate((n) => window.harness.invoke('groups:create', { name: n }), name)
  )
  await app.evaluate(
    (_e, paths) => {
      ;(
        globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
      ).__e2e.queueOpenDialog(paths)
    },
    [folder]
  )
  const picked = data<StoragePickResult>(
    await page.evaluate(
      (g) => window.harness.invoke('storage:pickFolder', { groupId: g }),
      group.id
    )
  )
  if (!picked.picked || !picked.token) throw new Error('expected a token')
  data<StorageState>(
    await page.evaluate(
      ([g, t]) =>
        window.harness.invoke('storage:link', {
          groupId: g as string,
          token: t as string,
          choice: 'move'
        }),
      [group.id, picked.token]
    )
  )
  await page.evaluate((g) => window.harness.invoke('groups:open', { groupId: g }), group.id)
  const sections = data<Section[]>(
    await page.evaluate((g) => window.harness.invoke('sections:list', { groupId: g }), group.id)
  )
  const notes = sections.find((s) => s.kind === 'notes')
  if (!notes) throw new Error('no Notes section')
  return { id: group.id, notesId: notes.id }
}

test('storage:unlink keep-current copies the folder back and leaves it untouched', async ({
  app,
  window: page
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'harness-unlink-')))
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Service map.md'), 'folder text')
    const { id, notesId } = await createLinkedGroup(page, app, folder, 'Shop')

    const state = data<StorageState>(
      await page.evaluate(
        (g) => window.harness.invoke('storage:unlink', { groupId: g, choice: 'keep-current' }),
        id
      )
    )
    expect(state).toMatchObject({ mode: 'app', linkedPath: null, keptAside: false })
    const items = data<ItemSummary[]>(
      await page.evaluate((s) => window.harness.invoke('items:list', { sectionId: s }), notesId)
    )
    expect(items.map((i) => i.title)).toEqual(['Service map'])
    expect(await readFile(join(folder, 'Notes', 'Service map.md'), 'utf8')).toBe('folder text')

    const again = await page.evaluate(
      (g) => window.harness.invoke('storage:unlink', { groupId: g, choice: 'keep-current' }),
      id
    )
    expect(again).toEqual({ ok: false, error: { code: 'STORAGE_NOT_LINKED' } })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('a renamed folder raises availability, locate relinks it, use-app-storage gives up on it', async ({
  app,
  window: page
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'harness-locate-')))
  const moved = `${folder}-renamed`
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Service map.md'), 'folder text')
    const { id, notesId } = await createLinkedGroup(page, app, folder, 'Shop')
    await page.evaluate(() => {
      window.__avail = []
      window.harness.on('availability:changed', (e) => window.__avail?.push(e))
    })
    const getState = async (): Promise<StorageState> =>
      data<StorageState>(
        await page.evaluate((g) => window.harness.invoke('storage:get', { groupId: g }), id)
      )
    expect(await getState()).toMatchObject({ mode: 'linked', available: true })

    await rename(folder, moved)
    // groups:open runs an availability check (so do focus and the 30 s timer).
    await page.evaluate((g) => window.harness.invoke('groups:open', { groupId: g }), id)
    await expect
      .poll(() => page.evaluate(() => window.__avail))
      .toEqual([{ groupId: id, knowledgeRoot: true, available: false }])
    expect(await getState()).toMatchObject({ available: false, hasKnowledge: false })
    // The items stay indexed while the folder is missing.
    expect(
      data<ItemSummary[]>(
        await page.evaluate((s) => window.harness.invoke('items:list', { sectionId: s }), notesId)
      ).map((i) => i.title)
    ).toEqual(['Service map'])

    // Folder available again is refused by use-app-storage once it is located.
    await app.evaluate(
      (_e, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [moved]
    )
    const located = data<StorageLocateResult>(
      await page.evaluate((g) => window.harness.invoke('storage:locate', { groupId: g }), id)
    )
    expect(located).toMatchObject({
      located: true,
      looksLikeKnowledge: true,
      state: { mode: 'linked', linkedPath: moved, available: true }
    })
    expect(await getState()).toMatchObject({ available: true, hasKnowledge: true })
    expect(
      data<ItemSummary[]>(
        await page.evaluate((s) => window.harness.invoke('items:list', { sectionId: s }), notesId)
      ).map((i) => i.title)
    ).toEqual(['Service map'])
    expect(
      await page.evaluate((g) => window.harness.invoke('storage:useAppStorage', { groupId: g }), id)
    ).toEqual({ ok: false, error: { code: 'STORAGE_ROOT_AVAILABLE' } })

    // Gone again, and this time the user gives up on it.
    await rename(moved, folder)
    await page.evaluate((g) => window.harness.invoke('groups:open', { groupId: g }), id)
    await expect.poll(() => page.evaluate(() => window.__avail?.length)).toBe(2)
    expect((await page.evaluate(() => window.__avail))?.[1]).toEqual({
      groupId: id,
      knowledgeRoot: true,
      available: false
    })
    const onApp = data<StorageState>(
      await page.evaluate((g) => window.harness.invoke('storage:useAppStorage', { groupId: g }), id)
    )
    expect(onApp).toMatchObject({ mode: 'app', hasKnowledge: false })
    expect(
      data<ItemSummary[]>(
        await page.evaluate((s) => window.harness.invoke('items:list', { sectionId: s }), notesId)
      )
    ).toEqual([])
    expect(await readFile(join(folder, 'Notes', 'Service map.md'), 'utf8')).toBe('folder text')
  } finally {
    await rm(folder, { recursive: true, force: true })
    await rm(moved, { recursive: true, force: true })
  }
})
