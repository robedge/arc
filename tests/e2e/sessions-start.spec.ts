// @spec: 003-sessions-brain-and-workers
// @spec: 013-session-branches-on-demand
// @regression
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import {
  arcBranches,
  branchOf,
  createGroupWithProjects,
  eventLog,
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

test('2.1 + 2.2: first tab, empty request, read-only project, no branch at start, rename, delete', async () => {
  rig = await launchRig({
    scenario: 'titled-fix-order-sync.jsonl',
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty' },
      { name: 'docs', kind: 'plain' }
    ]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!, repos['docs']!])

  // The Sessions tab is first and already open.
  const tabs = page.getByRole('tablist', { name: 'Sections' }).getByRole('tab')
  await expect(tabs.first()).toHaveText('Sessions')
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')

  // Empty request: red message under the box, no session.
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(dialog.getByText('Enter a request for the brain.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('[data-session-row]')).toHaveCount(0)

  // The web repository has unsaved changes, and the session starts anyway with no dialog.
  await startSession(page, { request: 'Why is the orders report slow?' })

  // The session screen opens with the request as the first message.
  const conversation = page.getByRole('log', { name: 'Conversation' })
  await expect(conversation).toBeVisible()
  await expect(conversation.locator('[data-message-role="user"]').first()).toHaveText(
    'Why is the orders report slow?'
  )
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // The brain replied: the session has a short name instead of "New session".
  await expect(page.locator('[data-session-name]')).toHaveText('Fix order sync')

  // Header: no repository has a session branch yet, only the read-only project is listed.
  const chips = page.getByRole('list', { name: 'Session branches' })
  await expect(chips.locator('[data-branch-chip="read-only"]')).toContainText('Read only')
  await expect(chips.locator('[data-branch-chip="read-only"]')).toContainText('docs')
  await expect(chips.locator('[data-branch-chip="branch"]')).toHaveCount(0)

  // Nothing was switched or created, and the unsaved changes are still in place.
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(branchOf(repos['web']!)).toBe('dev')
  expect(arcBranches(repos['api']!)).toEqual([])
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(readFileSync(join(repos['web']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  expect(readFileSync(join(repos['web']!, 'untracked.txt'), 'utf8')).toBe('new\n')

  // Rename shows in the header and the list.
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByLabel('Session name').fill('Orders report')
  await page.getByLabel('Session name').press('Enter')
  await expect(page.locator('[data-session-name]')).toHaveText('Orders report')
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  const rows = page.locator('[data-session-row]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Orders report')

  // Delete: gone from the list.
  await page.getByRole('button', { name: 'Session options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Session' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete Session' })).toContainText(
    'Its branches are kept in your repositories'
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(rows).toHaveCount(0)
})

async function setupThreeRepos(): Promise<Rig> {
  const r = await launchRig({
    scenario: 'branch-on-demand',
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'no-dev' },
      { name: 'infra', kind: 'dirty' }
    ]
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [
    r.repos['api']!,
    r.repos['web']!,
    r.repos['infra']!
  ])
  return r
}

test('starting a session leaves every repository on its branch with no arc/ branch', async () => {
  const r = await setupThreeRepos()
  const { page, repos } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })

  // The dirty infra repository does not stop the start and no dialog opens.
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  await expect(page.getByText('The orders report is slow because of one query.')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // Every repository is on the branch it was on, with no session branch, and infra keeps its changes.
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(branchOf(repos['web']!)).toBe('main')
  expect(branchOf(repos['infra']!)).toBe('dev')
  for (const name of ['api', 'web', 'infra']) expect(arcBranches(repos[name]!)).toEqual([])
  expect(readFileSync(join(repos['infra']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  expect(readFileSync(join(repos['infra']!, 'untracked.txt'), 'utf8')).toBe('new\n')
  await expect(
    page.getByRole('list', { name: 'Session branches' }).locator('[data-branch-chip="branch"]')
  ).toHaveCount(0)
})

test('a worker creates the session branch only in its own repository', async () => {
  const r = await setupThreeRepos()
  const { page, repos } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')

  // A worker in api: api moves to the session branch, web and infra are untouched.
  await sendToBrain(page, 'Start the api worker')
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')
  expect(branchOf(repos['web']!)).toBe('main')
  expect(branchOf(repos['infra']!)).toBe('dev')
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(arcBranches(repos['infra']!)).toEqual([])
  expect(readFileSync(join(repos['infra']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in api (from dev)' })
  ).toHaveCount(1)
  const chips = page.getByRole('list', { name: 'Session branches' })
  await expect(chips.locator('[data-branch-chip="branch"]')).toHaveText(/arc\/retry-work ← dev/)

  // A second worker, in web: the same name, from main. infra is still untouched.
  await sendToBrain(page, 'Start the web worker')
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['web']!)).toBe('arc/retry-work')
  expect(branchOf(repos['infra']!)).toBe('dev')
  expect(arcBranches(repos['infra']!)).toEqual([])
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in web (from main)' })
  ).toHaveCount(1)
  await expect(chips).toContainText('arc/retry-work ← main')
  await expect(chips).toContainText('arc/retry-work ← dev')
})
