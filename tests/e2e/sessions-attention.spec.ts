// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  answerQuestion,
  approve,
  deny,
  dock,
  expectNoDialog,
  expectNoneWaiting,
  expectWaiting,
  permissionAction,
  request
} from './attention-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

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
  await expectNoneWaiting(r.page)
})

test('2.7: a git push goes to the user; approving clears the dock and the worker resumes', async () => {
  const r = await setup('attention-push')
  const { page } = r
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await expect(card.locator('[data-worker-status]')).toHaveText(/needs approval/i)
  await expectWaiting(page, 1)
  // The group shows an amber dot and the session list says Needs attention.
  await expect(
    page.getByRole('navigation', { name: 'Groups' }).locator('[data-attention-dot]')
  ).toBeVisible()

  // The request is already docked above the message box: no click opens it, and nothing covers the session.
  await expectNoDialog(page)
  const panel = request(page, 'permission')
  await expect(permissionAction(panel)).toHaveText('git push origin arc/fix-order-sync')
  await expect(page.getByRole('article', { name: /Permission request from W1/ })).toBeVisible()
  await approve(panel)
  await expectNoneWaiting(page)
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
  const panel = request(page, 'permission')
  await expect(permissionAction(panel)).toHaveText('brew install jq')
  // The reason line: why Arc did not wave it through.
  await expect(
    panel.getByText(/installs software for the whole machine, so this needs you\./)
  ).toBeVisible()
  await deny(panel)
  await expectNoneWaiting(page)
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
  await expectWaiting(page, 1)
  await expect.poll(async () => (await notifications(app)).length).toBe(1)
  expect((await notifications(app))[0]!.body).toContain('How many retries should the client make?')

  // Clicking the notification opens the session with the question docked above the message box.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(page.locator('[data-session-status]').first()).toHaveText('Needs attention')
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __e2e: { clickNotification(i: number): void } }
    ).__e2e.clickNotification(0)
  })
  await expect(dock(page)).toBeVisible()
  await expect(dock(page).getByText('How many retries should the client make?')).toBeVisible()
  await expectNoDialog(page)

  // Quit and reopen: the request, the dock and the paused worker are still there.
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
  await expectWaiting(page2, 1)
  await expect(workerCard(page2, 'W1 · api-retry')).toHaveAttribute(
    'data-worker-card',
    'has_question'
  )

  // Answering clears it and the answer appears in the event log.
  await answerQuestion(request(page2, 'question'), 'Three attempts')
  await expectNoneWaiting(page2)
  await expect(eventLog(page2).filter({ hasText: 'Answered by you: Three attempts' })).toHaveCount(
    1
  )
})
