// @spec: 013-session-branches-on-demand
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  branchOf,
  createGroupWithProjects,
  launchRig,
  sendToBrain,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** Three git repositories on dev and one read-only folder, with a session named "Retry work". */
async function setup(scenario: string): Promise<Rig> {
  const r = await launchRig({
    scenario,
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'clean' },
      { name: 'infra', kind: 'clean' },
      { name: 'docs', kind: 'plain' }
    ]
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [
    r.repos['api']!,
    r.repos['web']!,
    r.repos['infra']!,
    r.repos['docs']!
  ])
  await startSession(r.page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(r.page.locator('[data-session-name]')).toHaveText('Retry work')
  return r
}

const chips = (page: Page) => page.getByRole('list', { name: 'Session branches' })

test('a new session counts its git projects and shows the read-only folder', async () => {
  const r = await setup('branch-on-demand')
  const { page } = r
  await expect(chips(page).getByRole('button', { name: '3 projects' })).toBeVisible()
  await expect(chips(page).locator('[data-branch-chip="branch"]')).toHaveCount(0)
  await expect(chips(page).locator('[data-branch-chip="read-only"]')).toContainText('Read only')
  await expect(chips(page).locator('[data-branch-chip="read-only"]')).toContainText('docs')
})

test('the api chip and 2 more projects appear without reopening', async () => {
  const r = await setup('branch-on-demand')
  const { page, repos } = r
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')

  const branchChips = chips(page).locator('[data-branch-chip="branch"]')
  await expect(branchChips).toHaveCount(1)
  await expect(branchChips).toContainText('api')
  await expect(branchChips).toContainText('arc/retry-work ← dev')
  const count = chips(page).getByRole('button', { name: '2 more projects' })
  await expect(count).toBeVisible()

  // The count lists the projects still without a branch, never the read-only folder.
  await count.click()
  await expect(count).toHaveAttribute('aria-expanded', 'true')
  const list = page.getByRole('list', { name: 'Projects without a session branch' })
  await expect(list.getByRole('listitem')).toHaveText(['web', 'infra'])
  await expect(list).not.toContainText('docs')
  await expect(list).not.toContainText('api')

  await page.keyboard.press('Escape')
  await expect(list).toHaveCount(0)
  await expect(count).toHaveAttribute('aria-expanded', 'false')
  await expect(count).toBeFocused()
  await expect(chips(page).locator('[data-branch-chip="read-only"]')).toContainText('Read only')
})

test('a session with a branch in every repository still shows one collapsed chip', async () => {
  // Seeded by letting a worker start in every repository: every git project then holds the same
  // branch label, the same header data a session from before branches on demand has.
  const r = await setup('branch-on-demand-all')
  const { page, repos } = r
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  await sendToBrain(page, 'Start the web worker')
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  await sendToBrain(page, 'Start the infra worker')
  await expect(workerCard(page, 'W3 · infra-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  for (const name of ['api', 'web', 'infra']) expect(branchOf(repos[name]!)).toBe('arc/retry-work')

  const branchChips = chips(page).locator('[data-branch-chip="branch"]')
  await expect(branchChips).toHaveCount(1)
  await expect(branchChips).toHaveText('arc/retry-work ← dev')
  await expect(chips(page).getByRole('button')).toHaveCount(0)
  await expect(chips(page).locator('[data-branch-chip="read-only"]')).toContainText('Read only')
})
