// @spec: 003-sessions-brain-and-workers
// @regression
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  git,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const badge = (page: Page) => page.getByRole('button', { name: /Needs attention, \d+ waiting/ })

async function setup(scenario: string, names: string[] = ['api']) {
  const r = await launchRig({ scenario, repos: names.map((name) => ({ name })) })
  rig = r
  await createGroupWithProjects(
    r,
    'Storefront',
    names.map((n) => r.repos[n]!)
  )
  return r
}

function sessionBranch(path: string): string {
  const found = git(path, 'branch', '--list', 'arc/*', '--format=%(refname:short)').trim()
  return found.split('\n')[0]!
}

function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

test('2.8: a Done worker is merged by itself, the brain is told, the summary lists the work', async () => {
  const r = await setup('am-clean')
  const { page, repos } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  await expect(card.locator('[data-worker-status]')).toHaveText(/merged/i)
  await expect(
    eventLog(page).filter({ hasText: /Merged W1 api-retry into arc\/retry-work/ })
  ).toHaveCount(1)

  // The branch holds the worker's commit, and the user's own checkout was brought up to date.
  const branch = sessionBranch(repos['api']!)
  expect(branch).toBe('arc/retry-work')
  expect(git(repos['api']!, 'log', branch, '--format=%s')).toContain('Add retry')
  expect(existsSync(join(repos['api']!, 'retry.txt'))).toBe(true)
  // The separate working copy is gone.
  expect(git(repos['api']!, 'worktree', 'list').trim().split('\n')).toHaveLength(1)

  // The brain was told, naming the worker and the branch, and that the merge was automatic.
  await expect
    .poll(() =>
      stdinTexts(r).some((t) =>
        t.includes('[Arc] Merged W1 api-retry into arc/retry-work automatically.')
      )
    )
    .toBe(true)

  // All merged: the brain posts the final summary in the conversation.
  await expect(page.getByText('Summary: api got retry.txt in the commit Add retry.')).toBeVisible()
  expect(
    stdinTexts(r).some((t) => t.includes('All workers finished. Summarise per repository'))
  ).toBe(true)
})

test('2.8: two workers edit the same line; the conflict is resolved and both changes land', async () => {
  const r = await setup('am-conflict')
  const { page, repos } = r
  await startSession(page, { request: 'Two edits', mode: 'Autonomous' })

  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 45_000
  })
  await expect(workerCard(page, 'W2 · api-timeout')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 45_000
  })
  await expect(
    eventLog(page).filter({ hasText: 'Resolved conflict in api/README.md' })
  ).toHaveCount(1)
  const branch = sessionBranch(repos['api']!)
  const readme = git(repos['api']!, 'show', `${branch}:README.md`)
  expect(readme).toContain('retry on failure')
  expect(readme).toContain('timeout of 5s')
  expect(readFileSync(join(repos['api']!, 'README.md'), 'utf8')).toContain('timeout of 5s')
  await expect(page.getByText('Summary: README.md has both notes.')).toBeVisible()
})

test('2.8: a conflict the resolver is not sure about asks the user and names the file', async () => {
  const r = await setup('am-unresolvable')
  const { page, repos } = r
  await startSession(page, { request: 'Two edits', mode: 'Autonomous' })

  await expect(badge(page)).toHaveCount(1, { timeout: 45_000 })
  await badge(page).click()
  const question = page.getByRole('dialog', { name: /Needs attention/ }).getByRole('article')
  await expect(question).toContainText('README.md')
  await expect(question).toContainText('retry on failure')
  await expect(question).toContainText('5 second timeout')
  await question.getByLabel('Your answer').fill('Keep both lines')
  await question.getByRole('button', { name: 'Send' }).click()
  await expect(badge(page)).toHaveCount(0)

  await expect(workerCard(page, 'W2 · api-timeout')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 45_000
  })
  const readme = git(repos['api']!, 'show', `${sessionBranch(repos['api']!)}:README.md`)
  expect(readme).toContain('retry on failure')
  expect(readme).toContain('timeout of 5s')
})

test('2.8: a change is shared W1 → W3 and W3 continues with it in place', async () => {
  const r = await setup('am-sync', ['api', 'web'])
  const { page } = r
  await startSession(page, { request: 'Share a column', mode: 'Autonomous' })

  await expect(
    eventLog(page).filter({ hasText: 'Shared W1 → W3: retry_status column' })
  ).toHaveCount(1, {
    timeout: 45_000
  })
  // W3 saw the change in its working copy before it carried on.
  await expect
    .poll(() =>
      readFakeLog(r).some((l) => {
        const shell = l['shell'] as { cmd?: string; out?: string } | undefined
        return !!shell?.cmd?.includes('retry_status.sql') && shell.out?.includes('present') === true
      })
    )
    .toBe(true)
  for (const title of ['W1 · api-retry', 'W2 · docs', 'W3 · api-client']) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'merged', {
      timeout: 45_000
    })
  }
  await expect(
    page.getByText('Summary: api has the column and its use; web has docs.')
  ).toBeVisible()
})
