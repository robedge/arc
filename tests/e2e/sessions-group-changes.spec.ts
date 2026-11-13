// @spec: 003-sessions-brain-and-workers
// @spec: 013-session-branches-on-demand
// @regression
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Result } from '../../src/shared/errors'
import type { ArcApi } from '../../src/shared/ipc/arc-api'
import type { Group } from '../../src/shared/types/group'
import type { StoragePickResult } from '../../src/shared/types/storage'
import {
  arcBranches,
  branchOf,
  createGroupWithProjects,
  eventLog,
  git,
  launchRig,
  readFakeLog,
  sendToBrain,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

declare global {
  interface Window {
    arc: ArcApi
  }
}

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

function data<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`IPC failed: ${result.error.code}`)
  return result.data
}

/** The argv of every run of the brain, oldest first. */
function brainRuns(r: Rig): string[][] {
  return readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is string[] =>
        Array.isArray(a) && a.some((x) => String(x).includes('[arc-role:brain]'))
    )
}

function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

test('2.11: a project added to the group joins the open session, gets a worker that merges; a relinked knowledge folder reaches the brain', async () => {
  // An external folder that already holds a note; the group's knowledge is linked to it later.
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'arc-linked-')))
  await mkdir(join(folder, 'Notes'))
  await writeFile(join(folder, 'Notes', 'Partitioning.md'), 'Partition by tenant id.\n')
  rig = await launchRig({
    scenario: 'group-changes',
    env: { FAKE_CLAUDE_LINKED: folder },
    repos: [{ name: 'api' }, { name: 'web', kind: 'no-dev' }]
  })
  const r = rig
  const { page, app, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Retry the client', mode: 'Autonomous' })

  // The session is named, and no repository has a session branch yet.
  const chips = page.getByRole('list', { name: 'Session branches' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work', { timeout: 30_000 })
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle')
  expect(brainRuns(r)).toHaveLength(1)
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(arcBranches(repos['api']!)).toEqual([])

  // Add the web repository to the group while the session stays open.
  await page.getByRole('tab', { name: 'Projects' }).click()
  await app.evaluate(
    (_, p) => {
      ;(
        globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
      ).__e2e.queueOpenDialog(p)
    },
    [repos['web']!]
  )
  await page.getByRole('button', { name: 'Add Project' }).click()
  await expect(page.getByRole('list', { name: 'Projects' }).getByText(repos['web']!)).toBeVisible()
  await page.getByRole('tab', { name: 'Sessions' }).click()

  // It joins with no dialog and no branch: both repositories stay where they were.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(chips.locator('[data-branch-chip="branch"]')).toHaveCount(0)
  expect(branchOf(repos['web']!)).toBe('main')
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(arcBranches(repos['api']!)).toEqual([])

  // The brain restarts with web at its next message, is told, and starts a worker there.
  await sendToBrain(page, 'Add a note in web')
  const card = workerCard(page, 'W1 · web-note')
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 45_000 })
  expect(git(repos['web']!, 'log', 'arc/retry-work', '--format=%s')).toContain('Add web note')
  // The worker created the branch in web, from main; api still has none.
  await expect(chips).toContainText('arc/retry-work ← main')
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in web (from main)' })
  ).toHaveCount(1)
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(arcBranches(repos['api']!)).toEqual([])
  const runs = brainRuns(r)
  expect(runs).toHaveLength(2)
  expect(runs[1]).toContain('--resume')
  expect(runs[1]).toContain('--add-dir')
  expect(runs[1]).toContain(repos['web']!)
  expect(runs[0]).not.toContain(repos['web']!)
  expect(stdinTexts(r).some((t) => t.includes('[Arc] The group changed'))).toBe(true)
  expect(
    stdinTexts(r).some((t) => t.includes('joined the group') && t.includes('first starts there'))
  ).toBe(true)
  await expect(page.getByText('Summary: web got web.txt.')).toBeVisible()

  // Link the group's knowledge to the external folder that already holds a note.
  const groups = data<Group[]>(await page.evaluate(() => window.arc.invoke('groups:list', {})))
  const groupId = groups.find((g) => g.name === 'Storefront')!.id
  await app.evaluate(
    (_, p) => {
      ;(
        globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
      ).__e2e.queueOpenDialog(p)
    },
    [folder]
  )
  const picked = data<StoragePickResult>(
    await page.evaluate((g) => window.arc.invoke('storage:pick-folder', { groupId: g }), groupId)
  )
  if (!picked.picked || !picked.token) throw new Error('expected a token')
  data(
    await page.evaluate(
      ([g, t]) =>
        window.arc.invoke('storage:link', {
          groupId: g as string,
          token: t as string,
          choice: 'move'
        }),
      [groupId, picked.token]
    )
  )

  // The brain's next launch is in the linked folder and the note is readable from it.
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle')
  await sendToBrain(page, 'What does the Partitioning note say?')
  await expect.poll(() => brainRuns(r).length, { timeout: 30_000 }).toBe(3)
  const third = brainRuns(r)[2]!
  const prompt = third[third.indexOf('--append-system-prompt') + 1] ?? ''
  expect(prompt).toContain(`The group's knowledge folder is ${folder}`)
  // Same working folder as the first run (the conversation resumes); the linked folder is added.
  expect(third).toContain(folder)
  expect(third).toContain('--add-dir')
  await expect
    .poll(
      () =>
        readFakeLog(r).some((l) => {
          const shell = l['shell'] as { cmd?: string; out?: string } | undefined
          return (
            (shell?.cmd ?? '').includes('Partitioning.md') &&
            (shell?.out ?? '').includes('Partition by tenant id.')
          )
        }),
      { timeout: 30_000 }
    )
    .toBe(true)
  expect(stdinTexts(r).some((t) => t.includes(`the knowledge folder is now ${folder}`))).toBe(true)
  await expect(page.getByText('Read the Partitioning note.')).toBeVisible()
})

test('2.5: reopening a session switches back only the repositories that have a session branch', async () => {
  rig = await launchRig({
    scenario: 'branch-on-demand',
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'no-dev' }
    ]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!])
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // Only api gets a worker, so only api gets the session branch.
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')
  expect(arcBranches(repos['web']!)).toEqual([])

  // The user moves both repositories to other branches.
  git(repos['api']!, 'checkout', '-b', 'elsewhere')
  git(repos['web']!, 'checkout', '-b', 'elsewhere')

  // Reopening the session brings api back to its session branch and leaves web alone.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  await expect.poll(() => branchOf(repos['api']!), { timeout: 15_000 }).toBe('arc/retry-work')
  expect(branchOf(repos['web']!)).toBe('elsewhere')
  expect(arcBranches(repos['web']!)).toEqual([])
  await expect(page.getByRole('dialog')).toHaveCount(0)
})
