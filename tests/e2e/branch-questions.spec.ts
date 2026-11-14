// @spec: 013-session-branches-on-demand
// @regression
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
import type { Rig, RepoKind } from './sessions-rig'
import {
  branchChoice,
  chooseForBranch,
  continueBranch,
  expectNoDialog,
  expectNoneWaiting,
  expectWaiting,
  requests
} from './attention-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** A dirty web (on main) and a clean api (on dev), with the session named "Retry work". */
async function setup(webKind: RepoKind = 'dirty-no-dev'): Promise<Rig> {
  const r = await launchRig({
    scenario: 'branch-on-demand',
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: webKind }
    ]
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!, r.repos['web']!])
  await startSession(r.page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(r.page.locator('[data-session-name]')).toHaveText('Retry work')
  await expect(r.page.getByText('The orders report is slow because of one query.')).toBeVisible()
  return r
}

/** Starts the api worker, then the web worker (the fake brain's order), and checks the waiting state. */
async function startBothWorkers(r: Rig, webBranch = 'main'): Promise<void> {
  const { page, repos } = r
  await sendToBrain(page, 'Start the api worker')

  // The clean api worker starts right away.
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['api']!)).toBe('arc/retry-work')

  await sendToBrain(page, 'Start the web worker')
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'queued', {
    timeout: 30_000
  })
  await expect(workerCard(page, 'W2 · web-note')).toContainText(
    'Waiting for your choice about unsaved changes in web'
  )
  // The api worker keeps working and web was not touched.
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working')
  expect(branchOf(repos['web']!)).toBe(webBranch)
  expect(arcBranches(repos['web']!)).toEqual([])
}

/** Checks the docked card: nothing was opened, the dock shows the count and the card names the files. */
async function showCard(page: Page, files = ['README.md', 'untracked.txt']) {
  await expectNoDialog(page)
  await expectWaiting(page, 1)
  const card = requests(page, 'branch')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText('Unsaved changes in web')
  for (const file of files) await expect(card).toContainText(file)
  await expect(card).toContainText('W2 web-note')
  return { card }
}

async function answer(page: Page, choiceLabel: string): Promise<void> {
  const { card } = await showCard(page)
  await chooseForBranch(card, choiceLabel)
  await expectNoneWaiting(page)
}

async function expectWebStarted(r: Rig): Promise<void> {
  const { page, repos } = r
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['web']!)).toBe('arc/retry-work')
  await expect(
    eventLog(page).filter({ hasText: 'Created arc/retry-work in web (from main)' })
  ).toHaveCount(1)
}

test('a dirty web waits in Needs attention while api starts; Set aside starts the web worker', async () => {
  const r = await setup()
  const { page, repos } = r
  await startBothWorkers(r)
  await answer(page, 'Set aside')
  await expectWebStarted(r)

  expect(git(repos['web']!, 'stash', 'list').trim()).not.toBe('')
  expect(git(repos['web']!, 'status', '--porcelain').trim()).toBe('')
})

test('no choice is preselected and Continue is unavailable until one is picked; Set aside then Continue starts the worker', async () => {
  const r = await setup()
  const { page, repos } = r
  await startBothWorkers(r)
  const { card } = await showCard(page)

  await expect(card.getByRole('radio')).toHaveCount(4)
  await expect(card.getByRole('radio', { checked: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Continue' })).toBeDisabled()
  // Pressing it anyway changes nothing.
  await card.getByRole('button', { name: 'Continue' }).click({ force: true })
  await expectWaiting(page, 1)
  expect(branchOf(repos['web']!)).toBe('main')

  await branchChoice(card, 'Set aside').check()
  await expect(card.getByRole('button', { name: 'Continue' })).toBeEnabled()
  await continueBranch(card)
  await expectNoneWaiting(page)
  await expectWebStarted(r)
  expect(git(repos['web']!, 'stash', 'list').trim()).not.toBe('')
})

test('Commit them first saves the changes on the original branch and starts the worker', async () => {
  const r = await setup()
  const { page, repos } = r
  const before = git(repos['web']!, 'rev-list', '--count', 'main').trim()
  await startBothWorkers(r)
  await answer(page, 'Commit them first')
  await expectWebStarted(r)

  expect(Number(git(repos['web']!, 'rev-list', '--count', 'main').trim())).toBe(Number(before) + 1)
  expect(git(repos['web']!, 'status', '--porcelain').trim()).toBe('')
  expect(git(repos['web']!, 'stash', 'list').trim()).toBe('')
})

test('Bring them along keeps the changes on the session branch and starts the worker', async () => {
  const r = await setup()
  const { page, repos } = r
  await startBothWorkers(r)
  await answer(page, 'Bring them along')
  await expectWebStarted(r)

  expect(readFileSync(join(repos['web']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  expect(readFileSync(join(repos['web']!, 'untracked.txt'), 'utf8')).toBe('new\n')
  expect(git(repos['web']!, 'stash', 'list').trim()).toBe('')
})

test('the question survives a quit and reopen and is answered afterwards', async () => {
  const r = await setup()
  const { repos } = r
  await startBothWorkers(r)

  await r.relaunch()
  const page = r.page
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'queued')
  expect(branchOf(repos['web']!)).toBe('main')

  await answer(page, 'Set aside')
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['web']!)).toBe('arc/retry-work')
  expect(git(repos['web']!, 'stash', 'list').trim()).not.toBe('')
})

const dontStartText = 'Not started: you chose to leave web as it is'
const clashText =
  'The changes in web clash with the branch the session branch starts from, so they cannot come along. Choose another way.'

test("Don't start fails the worker, leaves web alone and tells the brain", async () => {
  const r = await setup()
  const { page, repos } = r
  await startBothWorkers(r)
  await answer(page, "Don't start")

  const card = workerCard(page, 'W2 · web-note')
  await expect(card).toHaveAttribute('data-worker-card', 'failed', { timeout: 30_000 })
  await expect(card).toContainText(dontStartText)

  // web is on its original branch with its changes in place and no session branch.
  expect(branchOf(repos['web']!)).toBe('main')
  expect(arcBranches(repos['web']!)).toEqual([])
  expect(readFileSync(join(repos['web']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  expect(readFileSync(join(repos['web']!, 'untracked.txt'), 'utf8')).toBe('new\n')
  expect(git(repos['web']!, 'stash', 'list').trim()).toBe('')
  // The api worker was not affected.
  await expect(workerCard(page, 'W1 · api-note')).toHaveAttribute('data-worker-card', 'working')

  // The brain was told, and its scripted reply reaches the chat.
  await expect(
    page.getByText('The web worker was not started, as you chose to leave web as it is.')
  ).toBeVisible({ timeout: 30_000 })
  const note = readFakeLog(r).find(
    (l) =>
      l['stdin'] !== undefined &&
      JSON.stringify(l['stdin']).includes('[Arc] The user chose not to start work in web')
  )
  expect(note).toBeDefined()
  expect(JSON.stringify(note)).toContain('Not started: W2 web-note')
})

test('a failed carry shows a warning on the card, then Set aside starts the worker', async () => {
  const r = await setup('dirty-clash')
  const { page, repos } = r
  await startBothWorkers(r, 'side')

  const { card } = await showCard(page, ['README.md'])
  await chooseForBranch(card, 'Bring them along')

  // The card stays, with the warning, and Bring them along is gone.
  await expect(card).toContainText(clashText)
  await expect(branchChoice(card, 'Bring them along')).toHaveCount(0)
  for (const label of ['Set aside', 'Commit them first', "Don't start"]) {
    await expect(branchChoice(card, label)).toHaveCount(1)
  }
  await expect(card.getByRole('radio')).toHaveCount(3)
  expect(branchOf(repos['web']!)).toBe('side')
  expect(arcBranches(repos['web']!)).toEqual([])
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'queued')

  await branchChoice(card, 'Set aside').check()
  await continueBranch(card)
  await expectNoneWaiting(page)
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })
  expect(branchOf(repos['web']!)).toBe('arc/retry-work')
  expect(git(repos['web']!, 'stash', 'list').trim()).not.toBe('')
})

test('stopping the only waiting worker removes the card and clears the dock', async () => {
  const r = await setup()
  const { page, repos } = r
  await startBothWorkers(r)
  await expectWaiting(page, 1)

  await page.getByRole('button', { name: 'Details for W2 · web-note' }).click()
  const dialog = page.getByRole('dialog', { name: 'W2 · web-note' })
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await dialog.getByRole('button', { name: 'Stop worker' }).click()
  await expect(workerCard(page, 'W2 · web-note')).toHaveAttribute('data-worker-card', 'stopped')

  await expectNoneWaiting(page)
  await expect(requests(page, 'branch')).toHaveCount(0)
  expect(branchOf(repos['web']!)).toBe('main')
  expect(arcBranches(repos['web']!)).toEqual([])
})
