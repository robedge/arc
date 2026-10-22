// @spec: 004-change-review
// @regression
import { expect, test } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, workerCard } from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  closeReview,
  fileRow,
  launchReviewRig,
  openGate,
  openReview,
  paintedColour,
  repoGroup,
  reviewButton,
  reopenSession,
  reviewScreen,
  spawnAndMerge
} from './review-rig'

// One Arc run for the whole file: the tests build on each other, in this order.
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let rig: Rig
test.beforeAll(async () => {
  rig = await launchReviewRig()
  await spawnAndMerge(rig)
})
test.afterAll(async () => {
  await rig?.dispose()
})

const progress = (rig: Rig) => rig.page.locator('[data-review-progress]')

/** Ticks (or unticks) the Reviewed box of some api files; setting an already-set box does nothing. */
async function setReviewed(rig: Rig, paths: string[], on: boolean): Promise<void> {
  for (const path of paths)
    await fileRow(rig.page, 'api', path).getByRole('checkbox').setChecked(on)
}

const FIVE = ['README.md', 'config.txt', 'logo.png', 'src/client.ts', 'src/queue.ts']

/** Lets W4 make its change and waits until it is merged. */
async function mergeW4(rig: Rig): Promise<void> {
  openGate(rig)
  await expect(workerCard(rig.page, 'W4 · api-late')).toHaveAttribute(
    'data-worker-card',
    'merged',
    {
      timeout: 60_000
    }
  )
}

test('2.1: the button counts the changed files, and Back to session restores the conversation', async () => {
  const { page } = rig
  await closeReview(page)
  await expect(reviewButton(page)).toHaveText('Review changes · 12')
  await expect(reviewButton(page)).not.toHaveAttribute('aria-disabled', 'true')

  const conversation = page.getByRole('log', { name: 'Conversation' })
  await conversation.evaluate((el) => (el.scrollTop = 150))
  const before = await conversation.evaluate((el) => ({
    scrollTop: el.scrollTop,
    text: (el as HTMLElement).innerText
  }))
  expect(before.scrollTop).toBeGreaterThan(0)

  await openReview(page)
  await expect(page.getByRole('heading', { name: 'Review changes · 12' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to session' }).click()
  await expect(reviewScreen(page)).toHaveCount(0)

  const after = await conversation.evaluate((el) => ({
    scrollTop: el.scrollTop,
    text: (el as HTMLElement).innerText
  }))
  expect(after).toEqual(before)
})

test('2.2: files are grouped by repository, with status, counts and workers; dev moving on is ignored', async () => {
  const { page, repos } = rig
  // Someone else commits to dev after the session started (the checkout stays on the session branch).
  const side = join(rig.root, 'dev-side')
  git(repos['api']!, 'worktree', 'add', side, 'dev')
  writeFileSync(join(side, 'dev-only.txt'), 'someone else\n')
  git(side, 'add', 'dev-only.txt')
  git(side, 'commit', '-m', 'dev moves on')
  git(repos['api']!, 'worktree', 'remove', '--force', side)

  await openReview(page)
  const api = repoGroup(page, 'api')
  const web = repoGroup(page, 'web')
  await expect(api.locator('[data-review-file]')).toHaveCount(5)
  await expect(web.locator('[data-review-file]')).toHaveCount(7)
  for (const path of ['README.md', 'config.txt', 'logo.png', 'src/client.ts', 'src/queue.ts']) {
    await expect(fileRow(page, 'api', path)).toBeVisible()
  }
  await expect(fileRow(page, 'web', 'big.txt')).toBeVisible()
  await expect(web.locator('[data-review-file="config.txt"]')).toHaveCount(0)
  await expect(page.locator('[data-review-file="dev-only.txt"]')).toHaveCount(0)

  // W1 added src/queue.ts and W3 changed it later.
  const queue = fileRow(page, 'api', 'src/queue.ts')
  await expect(queue).toContainText('Added')
  await expect(queue.locator('[data-workers]')).toHaveText(/^\s*W1,\s*W3\s*$/)
  await expect(queue.locator('[data-counts]')).toContainText('+6')
  await expect(fileRow(page, 'api', 'config.txt')).toContainText('Changed')
  await expect(fileRow(page, 'api', 'config.txt').locator('[data-counts]')).toContainText('+1')
})

test('2.2: a selected file shows red removed lines, green added lines and context', async () => {
  const { page } = rig
  await openReview(page)
  await fileRow(page, 'api', 'config.txt').click()
  const view = page.locator('[data-diff-view]')
  const removed = view.locator('[data-diff-line="del"]')
  const added = view.locator('[data-diff-line="add"]')
  const context = view.locator('[data-diff-line="ctx"]')
  await expect(removed).toHaveCount(1)
  await expect(removed).toContainText('line 6')
  await expect(added).toHaveCount(1)
  await expect(added).toContainText('retry limit = 3')
  // Three unchanged lines either side of the change.
  await expect(context).toHaveCount(6)
  await expect(context.first()).toContainText('line 3')
  await expect(context.last()).toContainText('line 9')

  const red = await paintedColour(removed)
  expect(red.r).toBeGreaterThan(red.g)
  expect(red.r).toBeGreaterThan(red.b)
  const green = await paintedColour(added)
  expect(green.g).toBeGreaterThan(green.r)
  const family = await added.evaluate((el) => getComputedStyle(el).fontFamily)
  expect(family).toMatch(/mono/i)
})

test('2.2: a binary file says so, and a 2,431-line file waits for Show anyway', async () => {
  const { page } = rig
  await openReview(page)
  await fileRow(page, 'api', 'logo.png').click()
  await expect(page.locator('[data-diff-state="binary"]')).toHaveText('Binary file changed')
  await expect(page.locator('[data-diff-line]')).toHaveCount(0)

  await fileRow(page, 'web', 'big.txt').click()
  await expect(page.locator('[data-diff-state="large"]')).toContainText('Large change: 2,431 lines')
  await expect(page.locator('[data-diff-line]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show anyway' }).click()
  await expect(page.locator('[data-diff-line="add"]').first()).toBeVisible()
  await expect(page.locator('[data-diff-state="large"]')).toHaveCount(0)
})

test('2.2: filtering by worker or repository narrows the list', async () => {
  const { page } = rig
  await openReview(page)
  await page.getByLabel('Worker filter').selectOption('W2')
  const rows = page.locator('[data-review-file-list] [data-review-file]')
  await expect(rows).toHaveCount(7)
  for (const workers of await rows.locator('[data-workers]').allTextContents()) {
    expect(workers.trim()).toBe('W2')
  }
  await expect(repoGroup(page, 'api')).toHaveCount(0)
  await page.getByLabel('Worker filter').selectOption({ label: 'All workers' })
  await expect(rows).toHaveCount(12)

  await page.getByLabel('Repository').selectOption({ label: 'api' })
  await expect(rows).toHaveCount(5)
  await expect(repoGroup(page, 'web')).toHaveCount(0)
  await page.getByLabel('Repository').selectOption({ label: 'All repositories' })
  await expect(rows).toHaveCount(12)
})

test('2.2: side-by-side puts removed lines left and added lines right, and is remembered', async () => {
  const { page } = rig
  await openReview(page)
  await fileRow(page, 'api', 'config.txt').click()
  await page.getByLabel('Single').check()
  await expect(page.locator('[data-diff-split]')).toHaveCount(0)
  await page.getByLabel('Side-by-side').check()
  const split = page.locator('[data-diff-split]')
  await expect(split).toBeVisible()
  await expect(split.locator('[data-split-cell="old"][data-diff-line="del"]')).toContainText(
    'line 6'
  )
  await expect(split.locator('[data-split-cell="new"][data-diff-line="add"]')).toContainText(
    'retry limit = 3'
  )
  await expect(split.locator('[data-split-cell="old"][data-diff-line="add"]')).toHaveCount(0)
  await expect(split.locator('[data-split-cell="new"][data-diff-line="del"]')).toHaveCount(0)

  // A fresh load of the window opens the review side-by-side.
  await page.reload()
  await reopenSession(page)
  await openReview(page)
  await expect(page.getByLabel('Side-by-side')).toBeChecked()
  await fileRow(page, 'api', 'config.txt').click()
  await expect(page.locator('[data-diff-split]')).toBeVisible()
  await page.getByLabel('Single').check()
  await expect(page.locator('[data-diff-split]')).toHaveCount(0)
})

test('2.5: ticking Reviewed shows the progress, e.g. "5 of 12 reviewed"', async () => {
  const { page } = rig
  await openReview(page)
  await setReviewed(rig, FIVE, false)
  await expect(progress(rig)).toHaveText('0 of 12 reviewed')
  await setReviewed(rig, FIVE, true)
  await expect(progress(rig)).toHaveText('5 of 12 reviewed')
  await expect(fileRow(page, 'api', 'config.txt')).toHaveAttribute('data-reviewed', 'true')
})

test('2.2 + 2.5: a later merge updates the open review, keeps the file open and clears the tick', async () => {
  const { page } = rig
  await openReview(page)
  await setReviewed(rig, FIVE, true)
  await fileRow(page, 'api', 'config.txt').click()
  await expect(page.locator('[data-diff-view]').locator('[data-diff-line="add"]')).toHaveCount(1)

  await mergeW4(rig)

  await expect(page.locator('[data-review-notice]')).toHaveText('Updated: 2 more files changed')
  await expect(page.getByRole('heading', { name: 'Review changes · 13' })).toBeVisible()
  await expect(fileRow(page, 'api', 'src/late.ts')).toBeVisible()
  // The same file is still open and shows the new change.
  await expect(fileRow(page, 'api', 'config.txt')).toHaveAttribute('aria-selected', 'true')
  const view = page.locator('[data-diff-view]')
  await expect(view).toContainText('line nine')
  await expect(view).toContainText('timeout = 30')

  // The ticked file changed again: its tick clears and the row says so.
  const config = fileRow(page, 'api', 'config.txt')
  await expect(config).toContainText('Changed since reviewed')
  await expect(config).not.toHaveAttribute('data-reviewed', 'true')
  await expect(config.getByRole('checkbox')).not.toBeChecked()
  // The untouched ticked files keep theirs.
  await expect(fileRow(page, 'api', 'README.md')).toHaveAttribute('data-reviewed', 'true')
  await expect(progress(rig)).toHaveText('4 of 13 reviewed')
})

test('2.2: edits made by hand in the user\'s folder are listed under "Not committed", without actions', async () => {
  const { page, repos } = rig
  const readme = join(repos['api']!, 'README.md')
  const original = readFileSync(readme, 'utf8')
  writeFileSync(readme, original + 'my own note\n')
  try {
    // The list reads the checkout again whenever the review loads.
    await closeReview(page)
    await openReview(page)
    const group = repoGroup(page, 'api')
    const hand = group.locator('[data-review-uncommitted]')
    await expect(hand).toContainText('Not committed')
    const row = fileRow(page, 'api', 'README.md', 'uncommitted')
    await expect(row).toBeVisible()
    await expect(row.getByRole('checkbox')).toHaveCount(0)
    await row.click()
    const view = page.locator('[data-diff-view]')
    await expect(view).toContainText('my own note')
    await expect(view.getByRole('button', { name: 'Undo changes' })).toHaveCount(0)
    await expect(view.getByRole('button', { name: /Add note/ })).toHaveCount(0)
    await expect(view.getByRole('checkbox')).toHaveCount(0)
    // The session's own README.md row is a different entry.
    await expect(fileRow(page, 'api', 'README.md')).toBeVisible()
  } finally {
    writeFileSync(readme, original)
  }
})

test('2.5: reviewed marks survive closing and reopening the session', async () => {
  await mergeW4(rig)
  await openReview(rig.page)
  await setReviewed(rig, ['config.txt'], false)
  await setReviewed(rig, ['README.md', 'logo.png', 'src/client.ts', 'src/queue.ts'], true)
  await expect(progress(rig)).toHaveText('4 of 13 reviewed')

  await rig.relaunch()
  const { page } = rig
  await reopenSession(page)
  await expect(reviewButton(page)).toHaveText('Review changes · 13')
  await openReview(page)
  await expect(progress(rig)).toHaveText('4 of 13 reviewed')
  for (const path of ['README.md', 'logo.png', 'src/client.ts', 'src/queue.ts']) {
    await expect(fileRow(page, 'api', path)).toHaveAttribute('data-reviewed', 'true')
  }
  await expect(fileRow(page, 'api', 'config.txt')).not.toHaveAttribute('data-reviewed', 'true')
})
