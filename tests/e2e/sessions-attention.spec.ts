// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
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
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

async function setup(scenario: string, extra: Partial<Parameters<typeof launchRig>[0]> = {}) {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }], ...extra })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

async function notifications(app: ElectronApplication): Promise<{ title: string; body: string }[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __e2e: { notifications: { title: string; body: string }[] } })
        .__e2e.notifications
  )
}

test('2.7: a question the brain can answer never reaches the user', async () => {
  const r = await setup('attention-question')
  await startSession(r.page, { request: 'Add retries', mode: 'Autonomous' })
  const card = workerCard(r.page, 'W1 · api-retry')
  await expect(eventLog(r.page).filter({ hasText: 'W1 question answered by brain' })).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', /working|done|merged/)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 20_000 })
  await expect(badge(r.page)).toHaveCount(0)
})

test('2.7: a git push goes to the user; approving clears the badge and the worker resumes', async () => {
  const r = await setup('attention-push')
  const { page } = r
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await expect(card.locator('[data-worker-status]')).toHaveText(/needs approval/i)
  await expect(badge(page)).toHaveCount(1)
  await expect(badge(page).locator('[data-count]')).toHaveText('1')
  await expect(badge(page)).toContainText('Needs attention')
  // The group shows an amber dot and the session list says Needs attention.
  await expect(
    page.getByRole('navigation', { name: 'Groups' }).locator('[data-attention-dot]')
  ).toBeVisible()

  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText('git push origin arc/fix-order-sync')
  await expect(dialog.getByRole('article', { name: /W1/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(badge(page)).toHaveCount(0)
  await expect(card).toHaveAttribute('data-worker-card', /working|done|merged/)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 20_000 })

  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('[data-session-status]').first()).not.toHaveText('Needs attention')
})

test('2.7: brew install reaches the user even when the plan mentions it; Deny is logged', async () => {
  const r = await setup('attention-brew')
  const { page } = r
  await startSession(page, { request: 'Add jq tooling', mode: 'Autonomous' })

  await expect(workerCard(page, 'W1 · tooling')).toHaveAttribute(
    'data-worker-card',
    'needs_approval'
  )
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText('brew install jq')
  await expect(dialog.locator('[data-reason]')).toBeVisible()
  await dialog.getByRole('button', { name: 'Deny' }).click()
  await expect(badge(page)).toHaveCount(0)
  await expect(eventLog(page).filter({ hasText: 'Denied by you' })).toHaveCount(1)
  // Told it was denied, the worker keeps going without it.
  await expect(workerCard(page, 'W1 · tooling')).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    {
      timeout: 20_000
    }
  )
})

test('2.7: a question for the user, its answer, the notification, the amber dot and a restart', async () => {
  const r = await setup('attention-escalate')
  const { page, app } = r
  // Arc counts as being in the background.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __e2e: { forceUnfocused: boolean } }).__e2e.forceUnfocused = true
  })
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')
  await expect(card.locator('[data-worker-status]')).toHaveText(/has a question/i)
  await expect(badge(page)).toHaveCount(1)
  await expect.poll(async () => (await notifications(app)).length).toBe(1)
  expect((await notifications(app))[0]!.body).toContain('How many retries should the client make?')

  // Clicking the notification opens the session with the dialog open.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('[data-session-status]').first()).toHaveText('Needs attention')
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __e2e: { clickNotification(i: number): void } }
    ).__e2e.clickNotification(0)
  })
  await expect(attentionDialog(page)).toBeVisible()
  await expect(
    attentionDialog(page).getByText('How many retries should the client make?')
  ).toBeVisible()
  await page.keyboard.press('Escape')

  // Quit and reopen: the request, the badge and the paused worker are still there.
  await r.relaunch()
  const page2 = r.page
  await page2
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await expect(
    page2.getByRole('navigation', { name: 'Groups' }).locator('[data-attention-dot]')
  ).toBeVisible()
  await page2.locator('[data-session-row]').first().click()
  await expect(badge(page2)).toHaveCount(1)
  await expect(workerCard(page2, 'W1 · api-retry')).toHaveAttribute(
    'data-worker-card',
    'has_question'
  )

  // Answering clears it and the answer appears in the event log.
  await badge(page2).click()
  const dialog = attentionDialog(page2)
  await dialog.getByLabel('Your answer').fill('Three attempts')
  await dialog.getByRole('button', { name: 'Send' }).click()
  await expect(badge(page2)).toHaveCount(0)
  await expect(eventLog(page2).filter({ hasText: 'Answered by you: Three attempts' })).toHaveCount(
    1
  )
})
