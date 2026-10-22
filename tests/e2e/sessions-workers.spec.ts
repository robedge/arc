// @spec: 003-sessions-brain-and-workers
// @regression
import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
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

const STATUS_WORDS = [
  'Queued',
  'Starting',
  'Working',
  'Needs approval',
  'Has a question',
  'Done',
  'Merged',
  'Failed',
  'Stopped'
]

async function openDetails(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `Details for ${title}` }).click()
  await expect(page.getByRole('dialog', { name: title })).toBeVisible()
}

test('2.6: limit 2 queues the third worker; details, Stop with unmerged commits, Remove', async () => {
  rig = await launchRig({ scenario: 'workers', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Three jobs', mode: 'Autonomous', limit: 2 })

  const sleeper = workerCard(page, 'W1 · sleeper')
  const committer = workerCard(page, 'W2 · committer')
  const third = workerCard(page, 'W3 · third')
  await expect(sleeper).toHaveAttribute('data-worker-card', 'working')
  await expect(committer).toHaveAttribute('data-worker-card', 'working')
  await expect(third).toHaveAttribute('data-worker-card', 'queued')

  // The status is always a word, never only a colour.
  for (const card of await page.locator('[data-worker-card]').all()) {
    const word = (await card.locator('[data-worker-status]').innerText()).trim()
    expect(STATUS_WORDS.map((w) => w.toUpperCase())).toContain(word.toUpperCase())
  }
  await expect(sleeper.locator('[data-worker-status]')).toHaveText(/working/i)
  await expect(sleeper).toContainText('Running tests in api')
  await expect(third.locator('[data-worker-status]')).toHaveText(/queued/i)

  // A queued worker has Stop and no Remove.
  await openDetails(page, 'W3 · third')
  let dialog = page.getByRole('dialog', { name: 'W3 · third' })
  await expect(dialog.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Remove' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Close' }).click()

  // Details: task, latest report, changed files, working copy and Stop.
  await openDetails(page, 'W2 · committer')
  dialog = page.getByRole('dialog', { name: 'W2 · committer' })
  await expect(dialog.getByText('Commit a file and keep working')).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Latest report' })).toBeVisible()
  await expect(dialog.locator('[data-changed-files]')).toContainText('c.txt')
  const worktree = (await dialog.locator('[data-worktree-paths] li').first().innerText()).trim()
  expect(existsSync(worktree)).toBe(true)
  await expect(dialog.getByRole('button', { name: 'Remove' })).toHaveCount(0)

  // Stop asks first and says how many commits are lost.
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(dialog.locator('[data-unmerged-warning]')).toContainText(
    'Its 1 unmerged commit will be discarded.'
  )
  await dialog.getByRole('button', { name: 'Stop worker' }).click()
  await expect(committer).toHaveAttribute('data-worker-card', 'stopped')
  await expect(committer.locator('[data-worker-status]')).toHaveText(/stopped/i)
  expect(existsSync(worktree)).toBe(false)
  await expect(
    eventLog(page).filter({ hasText: 'Stopped by you; working copy removed' }).first()
  ).toContainText('(1 unmerged commit discarded)')
  // The freed slot starts the queued worker.
  await expect(third).toHaveAttribute('data-worker-card', 'working')

  // Stopping a worker with nothing to lose logs the plain line; a stopped worker can be removed.
  await openDetails(page, 'W1 · sleeper')
  dialog = page.getByRole('dialog', { name: 'W1 · sleeper' })
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(dialog.locator('[data-unmerged-warning]')).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Stop worker' }).click()
  await expect(sleeper).toHaveAttribute('data-worker-card', 'stopped')
  await expect(
    eventLog(page).filter({ hasText: /^.*Stopped by you; working copy removed$/ })
  ).toHaveCount(1)

  await openDetails(page, 'W1 · sleeper')
  await page
    .getByRole('dialog', { name: 'W1 · sleeper' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(sleeper).toHaveCount(0)
  await expect(eventLog(page).filter({ hasText: 'Removed W1 sleeper' })).toHaveCount(1)
  // The history stays in the event log.
  await expect(eventLog(page).filter({ hasText: 'Stopped by you' })).toHaveCount(2)
})

test('2.6: a worker that crashes shows Failed with a reason and the brain says what happens next', async () => {
  rig = await launchRig({ scenario: 'crash', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Crash please', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · crasher')
  await expect(card).toHaveAttribute('data-worker-card', 'failed')
  await expect(card.locator('[data-worker-status]')).toHaveText(/failed/i)
  await openDetails(page, 'W1 · crasher')
  const details = page.getByRole('dialog', { name: 'W1 · crasher' })
  await expect(details.getByRole('heading', { name: 'Failure reason' })).toBeVisible()
  await details.getByRole('button', { name: 'Close' }).click()
  await expect(
    page.getByText('The worker failed. I will tell you what to do next.').first()
  ).toBeVisible()
  expect(readFakeLog(rig).some((r) => JSON.stringify(r['stdin'] ?? '').includes('failed'))).toBe(
    true
  )
})
