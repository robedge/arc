// @spec: 013-session-branches-on-demand
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
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
import type { Rig, RepoSpec } from './sessions-rig'
import { expectWaiting } from './attention-rig'

/*
 * Acceptance tests for spec 013 that fill the gaps the slice specs left: the brain reading a
 * repository, one worker in two repositories, Plan-first approval, a clean worker next to a waiting
 * question in the other order, nine repositories in the header, and a session with a branch in
 * every repository that is reopened.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(scenario: string, repos: RepoSpec[]): Promise<Rig> {
  const r = await launchRig({ scenario, repos })
  rig = r
  await createGroupWithProjects(
    r,
    'Storefront',
    repos.map((spec) => r.repos[spec.name]!)
  )
  return r
}

const chips = (page: Page) => page.getByRole('list', { name: 'Session branches' })

test('2.1: a question about code is answered from the repository and creates no branch', async () => {
  const r = await setup('spec-013-read', [
    { name: 'api', kind: 'clean' },
    { name: 'web', kind: 'no-dev' },
    { name: 'infra', kind: 'clean' }
  ])
  const { page, repos } = r
  await startSession(page, { request: 'What does the api README say?', mode: 'Autonomous' })
  await expect(page.getByText('The api README says hello.')).toBeVisible()
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // The brain was started with every repository of the group readable, and read api's file.
  const brainRun = readFakeLog(r)
    .map((l) => l['argv'])
    .find(
      (a): a is string[] => Array.isArray(a) && a.some((x) => String(x).includes('arc-role:brain'))
    )
  expect(brainRun).toBeDefined()
  for (const name of ['api', 'web', 'infra']) expect(brainRun).toContain(repos[name]!)
  const read = readFakeLog(r).find(
    (l) =>
      (l['shell'] as { cmd?: string } | undefined)?.cmd?.includes('FAKE_CLAUDE_REPO_API') === true
  )
  expect((read?.['shell'] as { out?: string }).out).toContain('hello')

  // Nothing was switched or created.
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(branchOf(repos['web']!)).toBe('main')
  expect(branchOf(repos['infra']!)).toBe('dev')
  for (const name of ['api', 'web', 'infra']) expect(arcBranches(repos[name]!)).toEqual([])
})

test('2.2: one worker in api and web gives both their session branch before it shows Working', async () => {
  const r = await setup('spec-013-shared', [
    { name: 'api', kind: 'clean' },
    { name: 'web', kind: 'no-dev' },
    { name: 'infra', kind: 'clean' }
  ])
  const { page, repos } = r
  await startSession(page, { request: 'Look at both clients', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  for (const name of ['api', 'web', 'infra']) expect(arcBranches(repos[name]!)).toEqual([])

  await sendToBrain(page, 'Start the shared worker')
  await expect(workerCard(page, 'W1 · shared-note')).toHaveAttribute(
    'data-worker-card',
    'working',
    { timeout: 30_000 }
  )
  // Both repositories were switched by the time the worker shows Working; infra is untouched.
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')
  expect(branchOf(repos['web']!)).toBe('arc/retry-work')
  expect(branchOf(repos['infra']!)).toBe('dev')
  expect(arcBranches(repos['infra']!)).toEqual([])
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in api (from dev)' })
  ).toHaveCount(1)
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in web (from main)' })
  ).toHaveCount(1)
})

test('2.2: approving a Plan-first plan creates no branch; api gets its branch when its worker starts', async () => {
  const r = await setup('spec-013-plan', [
    { name: 'api', kind: 'clean' },
    { name: 'web', kind: 'clean' }
  ])
  const { page, repos } = r
  await startSession(page, { request: 'Look at the API client' })

  // The plan waits for approval: no branch anywhere and no worker yet.
  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan.locator('[data-plan-worker]')).toHaveCount(1)
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
  for (const name of ['api', 'web']) {
    expect(branchOf(repos[name]!)).toBe('dev')
    expect(arcBranches(repos[name]!)).toEqual([])
  }

  // Approving starts the worker in api, which creates the branch there. web is not in the plan.
  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')
  expect(branchOf(repos['web']!)).toBe('dev')
  expect(arcBranches(repos['web']!)).toEqual([])
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in api (from dev)' })
  ).toHaveCount(1)
})

test('2.3: a clean worker in api starts while the question about web is still waiting', async () => {
  const r = await setup('spec-013-web-first', [
    { name: 'api', kind: 'clean' },
    { name: 'web', kind: 'dirty-no-dev' }
  ])
  const { page, repos } = r
  await startSession(page, { request: 'Look at both clients', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // The web worker is asked about first and waits for the user's answer.
  await sendToBrain(page, 'Start the web worker')
  await expect(workerCard(page, 'W1 · web-note')).toHaveAttribute('data-worker-card', 'queued', {
    timeout: 30_000
  })
  await expectWaiting(page, 1)

  // While that question is waiting, the api worker starts without waiting.
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W2 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')

  // The question is still waiting and web is untouched.
  await expect(workerCard(page, 'W1 · web-note')).toHaveAttribute('data-worker-card', 'queued')
  await expectWaiting(page, 1)
  expect(branchOf(repos['web']!)).toBe('main')
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(git(repos['web']!, 'status', '--porcelain').trim()).not.toBe('')
})

test('2.4: nine repositories show "9 projects", then api and "8 more projects" that lists the rest', async () => {
  const others = ['web', 'infra', 'billing', 'search', 'auth', 'mobile', 'reports', 'gateway']
  const r = await setup('branch-on-demand', [
    { name: 'api', kind: 'clean' },
    ...others.map((name): RepoSpec => ({ name, kind: 'clean' }))
  ])
  const { page, repos } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // A new session: only the count, and no session branch.
  await expect(chips(page).getByRole('button', { name: '9 projects' })).toBeVisible()
  await expect(chips(page).locator('[data-branch-chip="branch"]')).toHaveCount(0)

  // After the first worker starts in api: api is listed and the other eight are counted.
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  const branchChips = chips(page).locator('[data-branch-chip="branch"]')
  await expect(branchChips).toHaveCount(1)
  await expect(branchChips).toContainText('arc/retry-work ← dev')
  const count = chips(page).getByRole('button', { name: '8 more projects' })
  await expect(count).toBeVisible()
  await count.click()
  const list = page.getByRole('list', { name: 'Projects without a session branch' })
  await expect(list.getByRole('listitem')).toHaveText(others)
  for (const name of others) expect(arcBranches(repos[name]!)).toEqual([])
})

test('2.5: a session with a branch in every repository reopens and switches all of them back', async () => {
  // Seeded by starting a worker in every repository: the same data a session from before
  // branches on demand has (a session branch in each repository, one shared label).
  const r = await setup('branch-on-demand-all', [
    { name: 'api', kind: 'clean' },
    { name: 'web', kind: 'clean' },
    { name: 'infra', kind: 'clean' }
  ])
  const { page, repos } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  for (const [command, title] of [
    ['api', 'W1 · api-note'],
    ['web', 'W2 · web-note'],
    ['infra', 'W3 · infra-note']
  ] as const) {
    await sendToBrain(page, `Start the ${command} worker`)
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'working', {
      timeout: 30_000
    })
  }
  for (const name of ['api', 'web', 'infra']) expect(branchOf(repos[name]!)).toBe('arc/retry-work')

  // The user moves every repository to another branch, then reopens the session.
  for (const name of ['api', 'web', 'infra']) git(repos[name]!, 'checkout', '-b', 'elsewhere')
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // It opens with no dialog, every repository is back on the session branch, and the header is
  // the single collapsed chip it always was.
  for (const name of ['api', 'web', 'infra']) {
    await expect.poll(() => branchOf(repos[name]!), { timeout: 15_000 }).toBe('arc/retry-work')
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(chips(page).locator('[data-branch-chip="branch"]')).toHaveText(
    'arc/retry-work ← dev'
  )
  await expect(chips(page).getByRole('button')).toHaveCount(0)
})
