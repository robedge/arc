// @spec: 004-change-review
// @regression
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, launchRig, startSession, workerCard } from './sessions-rig'
import type { Rig } from './sessions-rig'
import { fileRow, launchReviewRig, reviewButton, reviewScreen } from './review-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('2.1: with no merged work the button is disabled and says "No changes yet"', async () => {
  rig = await launchReviewRig()
  const { page } = rig
  const button = reviewButton(page)
  await expect(button).toHaveText('Review changes · 0')
  await expect(button).toHaveAttribute('aria-disabled', 'true')
  await button.hover()
  await expect(page.getByRole('tooltip')).toHaveText('No changes yet')
  // Clicking a disabled button opens nothing.
  await button.click({ force: true })
  await expect(reviewScreen(page)).toHaveCount(0)
})

test('2.1: the final summary ends with a Review changes link that opens the review', async () => {
  rig = await launchRig({ scenario: 'am-clean', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 45_000
  })

  const summary = page
    .locator('[data-message-role="brain"]')
    .filter({ hasText: 'Summary: api got retry.txt in the commit Add retry.' })
  await expect(summary).toBeVisible()
  // Only the summary carries the link; the earlier replies do not.
  await expect(
    page.locator('[data-message-role] button', { hasText: 'Review changes' })
  ).toHaveCount(1)
  await expect(reviewScreen(page)).toHaveCount(0)

  await summary.getByRole('button', { name: 'Review changes' }).click()
  await expect(reviewScreen(page)).toBeVisible()
  await expect(fileRow(page, 'api', 'retry.txt')).toBeVisible()
  await expect(fileRow(page, 'api', 'retry.txt')).toContainText('Added')
})
