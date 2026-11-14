// @spec: 014-inline-needs-attention
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, startSession, workerCard } from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  approve,
  dockHeading,
  expectNoDialog,
  expectNoneWaiting,
  expectWaiting,
  permissionFrom,
  pendingAction,
  request
} from './attention-rig'

/**
 * Spec 014 slice 7: a request whose worker the user stopped leaves the dock and leaves no record, while quitting
 * and starting Arc again keeps the request for the resumed worker.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(scenario: string): Promise<Rig> {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

/** Stops a worker from its details dialog and confirms. */
async function stopWorker(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: `Details for ${title}` }).click()
  const dialog = page.getByRole('dialog', { name: title })
  await dialog.getByRole('button', { name: 'Stop', exact: true }).click()
  await dialog.getByRole('button', { name: 'Stop worker' }).click()
  await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'stopped')
}

const groupDot = (page: Page) =>
  page.getByRole('navigation', { name: 'Groups' }).locator('[data-attention-dot]')

test('7.1: stopping the worker that waits for a permission clears its panel, the dock and the count, and leaves no record', async () => {
  const r = await setup('attention-push')
  const { page } = r
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })
  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute(
    'data-worker-card',
    'needs_approval'
  )
  await expectWaiting(page, 1)
  await expect(groupDot(page)).toBeVisible()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('[data-session-status]').first()).toHaveText('Needs attention')
  await page.locator('[data-session-row]').first().click()
  await expectWaiting(page, 1)

  await stopWorker(page, 'W1 · api-retry')

  await expectNoneWaiting(page)
  await expect(request(page, 'permission')).toHaveCount(0)
  await expectNoDialog(page)
  await expect(groupDot(page)).toHaveCount(0)
  await expect(workerCard(page, 'W1 · api-retry').locator('[data-worker-status]')).toHaveText(
    /stopped/i
  )
  await expect(
    page.getByRole('log', { name: 'Conversation' }).locator('[data-record]')
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('[data-session-status]').first()).not.toHaveText('Needs attention')
})

test('7.2: stopping one of two waiting workers removes only its panel; the other can still be approved', async () => {
  const r = await setup('rules-two')
  const { page } = r
  await startSession(page, { request: 'Two writers', mode: 'Autonomous' })
  await expectWaiting(page, 2, { timeout: 30_000 })

  await stopWorker(page, 'W1 · writer-one')

  await expect(dockHeading(page)).toHaveAccessibleName('Needs attention · 1')
  await expectWaiting(page, 1)
  await expect(permissionFrom(page, 'W1')).toHaveCount(0)
  await expect(permissionFrom(page, 'W2')).toHaveCount(1)
  expect(await pendingAction(page)).toContain('z-two.txt')

  await approve(permissionFrom(page, 'W2'))
  await expectNoneWaiting(page)
  await expect(workerCard(page, 'W2 · writer-two')).toHaveAttribute(
    'data-worker-card',
    /working|done|merged/
  )
  await expect(workerCard(page, 'W1 · writer-one')).toHaveAttribute('data-worker-card', 'stopped')
})

test('7.3: after quitting and starting Arc again, a pending request is still docked and can be answered', async () => {
  const r = await setup('attention-push')
  const { page } = r
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })
  await expectWaiting(page, 1)
  const command = await pendingAction(page)
  expect(command).toBe('git push origin arc/fix-order-sync')

  await r.relaunch()
  const again = r.page
  await again
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await again.locator('[data-session-row]').first().click()

  await expectWaiting(again, 1, { timeout: 30_000 })
  expect(await pendingAction(again)).toBe(command)
  await expect(
    again.getByRole('log', { name: 'Conversation' }).locator('[data-record]')
  ).toHaveCount(0)

  await approve(request(again, 'permission'))
  await expectNoneWaiting(again)
})
