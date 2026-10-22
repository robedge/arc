import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '../../src/shared/errors'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import type { Group } from '../../src/shared/types/group'
import type { ItemSummary } from '../../src/shared/types/item'
import type { Section } from '../../src/shared/types/section'
import type { StoragePickResult, StorageState } from '../../src/shared/types/storage'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
    __phases?: string[]
  }
}

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`IPC failed: ${result.error.code}`)
  return result.data
}

test('storage:pickFolder + storage:link move merges into a linked folder', async ({
  app,
  window: page
}) => {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'harness-link-')))
  try {
    await mkdir(join(folder, 'Notes'))
    await writeFile(join(folder, 'Notes', 'Service map.md'), 'folder text')

    const group = data<Group>(
      await page.evaluate(() => window.harness.invoke('groups:create', { name: 'Shop' }))
    )
    const id = group.id
    expect(
      data<StorageState>(
        await page.evaluate((g) => window.harness.invoke('storage:get', { groupId: g }), id)
      )
    ).toMatchObject({ mode: 'app', linkedPath: null, keptAside: false, hasKnowledge: false })
    await page.evaluate((g) => window.harness.invoke('groups:open', { groupId: g }), id)

    const sections = data<Section[]>(
      await page.evaluate((g) => window.harness.invoke('sections:list', { groupId: g }), id)
    )
    const notes = sections.find((s) => s.kind === 'notes')
    if (!notes) throw new Error('no Notes section')
    const created = data<ItemSummary>(
      await page.evaluate(
        (s) => window.harness.invoke('items:create', { sectionId: s, title: 'Service map' }),
        notes.id
      )
    )
    await page.evaluate(
      ([item, rev]) =>
        window.harness.invoke('items:save', {
          itemId: item as string,
          content: 'app text',
          baseRevision: rev as string
        }),
      [created.id, created.revision]
    )

    await page.evaluate(() => {
      window.__phases = []
      window.harness.on('storage:progress', (p) => window.__phases?.push(p.phase))
    })
    await app.evaluate(
      (_e, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [folder]
    )

    const picked = data<StoragePickResult>(
      await page.evaluate((g) => window.harness.invoke('storage:pickFolder', { groupId: g }), id)
    )
    if (!picked.picked || !picked.token) throw new Error('expected a token')
    expect(picked).toMatchObject({
      path: folder,
      blocked: null,
      hasKnowledge: true,
      targetHasContent: true,
      insideProjectRepo: null
    })

    // The renderer cannot supply its own path: a made-up token is refused.
    const bad = await page.evaluate(
      (g) => window.harness.invoke('storage:link', { groupId: g, token: 'nope', choice: 'move' }),
      id
    )
    expect(bad).toEqual({ ok: false, error: { code: 'STORAGE_TARGET_INVALID' } })

    const state = data<StorageState>(
      await page.evaluate(
        ([g, t]) =>
          window.harness.invoke('storage:link', {
            groupId: g as string,
            token: t as string,
            choice: 'move'
          }),
        [id, picked.token]
      )
    )
    expect(state).toMatchObject({
      mode: 'linked',
      linkedPath: folder,
      keptAside: false,
      available: true
    })

    expect((await readdir(join(folder, 'Notes'))).sort()).toEqual([
      'Service map (2).md',
      'Service map.md'
    ])
    expect(await readFile(join(folder, 'Notes', 'Service map.md'), 'utf8')).toBe('folder text')
    expect(await readFile(join(folder, 'Notes', 'Service map (2).md'), 'utf8')).toBe('app text')

    const items = data<ItemSummary[]>(
      await page.evaluate((s) => window.harness.invoke('items:list', { sectionId: s }), notes.id)
    )
    expect(items.map((i) => i.title).sort()).toEqual(['Service map', 'Service map (2)'])
    const phases = await page.evaluate(() => window.__phases ?? [])
    expect(phases).toContain('copying')
    expect(phases.at(-1)).toBe('done')
    const again = await page.evaluate(
      (g) => window.harness.invoke('storage:pickFolder', { groupId: g }),
      id
    )
    expect(again).toEqual({ ok: false, error: { code: 'STORAGE_ALREADY_LINKED' } })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
