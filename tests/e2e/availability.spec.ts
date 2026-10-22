import { mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Project } from '../../src/shared/types/project'
import type { Group } from '../../src/shared/types/group'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
    __availability: unknown[]
  }
}

test('a renamed folder is reported unavailable and Locate brings it back', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-avail-')))
  try {
    const original = join(root, 'alpha')
    const moved = join(root, 'alpha-moved')
    await mkdir(original)

    const group = (await page.evaluate(() =>
      window.harness.invoke('groups:create', { name: 'Shop' })
    )) as { ok: true; data: Group }
    const groupId = group.data.id

    await app.evaluate(
      (_e, paths) =>
        (
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths),
      [original]
    )
    const picked = await page.evaluate(
      (id) => window.harness.invoke('projects:pick', { groupId: id }),
      groupId
    )
    expect(picked.ok).toBe(true)

    await page.evaluate(() => {
      window.__availability = []
      window.harness.on('availability:changed', (p) => window.__availability.push(p))
    })
    const open = await page.evaluate(
      (id) => window.harness.invoke('groups:open', { groupId: id }),
      groupId
    )
    expect(open.ok).toBe(true)

    await rename(original, moved)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('focus'))
    await expect.poll(() => page.evaluate(() => window.__availability.length)).toBe(1)
    const listed = (await page.evaluate(
      (id) => window.harness.invoke('projects:list', { groupId: id }),
      groupId
    )) as { ok: true; data: Project[] }
    expect(await page.evaluate(() => window.__availability)).toEqual([
      { groupId, projectId: listed.data[0]?.id, available: false }
    ])
    expect(listed.data[0]?.available).toBe(false)

    await app.evaluate(
      (_e, paths) =>
        (
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths),
      [moved]
    )
    const relocated = (await page.evaluate(
      ([g, p]) => window.harness.invoke('projects:relocate', { groupId: g!, projectId: p! }),
      [groupId, listed.data[0]?.id]
    )) as { ok: true; data: Project }
    expect(relocated.data).toMatchObject({ path: moved, name: 'alpha-moved', available: true })

    // The relocate result already carries available: true, which is the baseline; no event follows.
    expect(await page.evaluate(() => window.__availability.length)).toBe(1)

    const after = (await page.evaluate(
      (id) => window.harness.invoke('projects:list', { groupId: id }),
      groupId
    )) as { ok: true; data: Project[] }
    expect(after.data.map((p) => [p.path, p.available])).toEqual([[moved, true]])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
