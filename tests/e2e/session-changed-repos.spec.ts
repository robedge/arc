// @spec: 013-session-branches-on-demand
// @regression
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import {
  arcBranches,
  branchOf,
  createGroupWithProjects,
  git,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import { fileRow, repoGroup, reviewButton, reviewScreen } from './review-rig'

let rig: Rig | undefined
const scratch: string[] = []
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const REPOS = [{ name: 'api' }, { name: 'web' }, { name: 'infra' }]

async function setup(scenario: string): Promise<Rig> {
  const r = await launchRig({ scenario, repos: REPOS })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [
    r.repos['api']!,
    r.repos['web']!,
    r.repos['infra']!
  ])
  return r
}

function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

test('a worker that changes api only: the summary, Review changes and Push branch name api alone', async () => {
  const r = await setup('am-clean')
  const { page, repos } = r
  // A local bare remote for every repository, so a repository with a branch could always be pushed.
  const remoteRoot = mkdtempSync(join(tmpdir(), 'arc-013-remote-'))
  scratch.push(remoteRoot)
  for (const name of ['api', 'web', 'infra']) {
    const remote = join(remoteRoot, `${name}.git`)
    git(r.root, 'init', '--bare', '-b', 'dev', remote)
    git(repos[name]!, 'remote', 'add', 'origin', remote)
  }

  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 30_000
  })
  await expect(page.getByText('Summary: api got retry.txt in the commit Add retry.')).toBeVisible()

  // Only api ever got a session branch.
  expect(arcBranches(repos['api']!)).toEqual(['arc/retry-work'])
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(arcBranches(repos['infra']!)).toEqual([])
  expect(branchOf(repos['web']!)).toBe('dev')

  // What the brain was told when every worker finished lists api and no other repository.
  const summaryNote = stdinTexts(r).find((t) => t.includes('All workers finished'))
  expect(summaryNote).toBeDefined()
  expect(summaryNote).toContain('api (')
  expect(summaryNote).not.toContain('web (')
  expect(summaryNote).not.toContain('infra (')
  expect(summaryNote).not.toContain('(no commits)')

  // Review changes lists api only.
  await reviewButton(page).click()
  await expect(reviewScreen(page)).toBeVisible()
  await expect(
    page.locator('[data-review-file-list]').getByRole('region', { name: 'api', exact: true })
  ).toBeVisible()
  await expect(page.locator('[data-review-file-list]').getByRole('region')).toHaveCount(1)
  await expect(repoGroup(page, 'web')).toHaveCount(0)
  await expect(repoGroup(page, 'infra')).toHaveCount(0)
  await expect(fileRow(page, 'api', 'retry.txt')).toBeVisible()

  // Push branch is offered for api only, and nothing is pushed until the user confirms.
  await expect(page.locator('[data-review-push]')).toHaveCount(1)
  const push = repoGroup(page, 'api').getByRole('button', { name: 'Push branch' })
  await expect(push).toBeEnabled()
  await push.click()
  const dialog = page.getByRole('dialog', { name: 'Push branch' })
  await expect(dialog.locator('[data-push-command]')).toHaveText(
    'git push -u origin arc/retry-work'
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(git(join(remoteRoot, 'api.git'), 'branch', '--list', 'arc/*').trim()).toBe('')
})

test('a session with no worker has nothing to review: the button says "No changes yet" and opens nothing', async () => {
  const r = await setup('branch-on-demand')
  const { page, repos } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  await expect(page.getByText('The orders report is slow because of one query.')).toBeVisible()

  for (const name of ['api', 'web', 'infra']) expect(arcBranches(repos[name]!)).toEqual([])
  const button = reviewButton(page)
  await expect(button).toHaveText('Review changes · 0')
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await button.hover()
  await expect(page.getByRole('tooltip')).toHaveText('No changes yet')
  await button.click({ force: true })
  await expect(reviewScreen(page)).toHaveCount(0)
})
