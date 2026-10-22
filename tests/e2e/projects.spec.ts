import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddProjectsResult, Project } from '../../src/shared/types/project'
import type { Group } from '../../src/shared/types/group'
import type { HarnessApi } from '../../src/shared/ipc/harness-api'
import { expect, test } from './fixtures'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

test('projects:pick adds the queued folders and projects:list returns them', async ({
  app,
  window: page
}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'harness-proj-')))
  try {
    const a = join(root, 'alpha')
    const b = join(root, 'beta')
    await mkdir(a)
    await mkdir(b)

    const group = await page.evaluate(() =>
      window.harness.invoke('groups:create', { name: 'Shop' })
    )
    expect(group.ok).toBe(true)
    const groupId = (group as { ok: true; data: Group }).data.id

    await app.evaluate(
      (_electron, paths) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(paths)
      },
      [a, b]
    )

    const picked = await page.evaluate(
      (id) => window.harness.invoke('projects:pick', { groupId: id }),
      groupId
    )
    expect(picked).toEqual({
      ok: true,
      data: { added: expect.any(Array), skipped: [] }
    })
    expect((picked as { ok: true; data: AddProjectsResult }).data.added).toHaveLength(2)

    const listed = await page.evaluate(
      (id) => window.harness.invoke('projects:list', { groupId: id }),
      groupId
    )
    const projects = (listed as { ok: true; data: Project[] }).data
    expect(projects.map((p) => [p.name, p.path, p.isGit, p.available])).toEqual([
      ['alpha', a, false, true],
      ['beta', b, false, true]
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
