// @spec: 014-inline-needs-attention
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  approve,
  dock,
  expectNoneWaiting,
  expectWaiting,
  pendingAction,
  request,
  requests
} from './attention-rig'

/*
 * Acceptance tests for spec 014 that fill the gaps the slice specs left (the slice specs are
 * attention-dock, attention-records, attention-stop, surface, prompt-v10 and the migrated approval,
 * attention, question and step-in specs). Each test is named after the functional-spec criterion it proves:
 * two sessions each with a request (2.1), the permission panel's parts and Send while empty (2.2), the
 * more-access panel (2.2), an answer that cannot be sent (2.2), a brain panel that looks like a request
 * (2.5) and a brain panel with a chart and a command (2.6).
 */

let rig: Rig | CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(scenario: string): Promise<{ r: Rig; page: Page }> {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return { r, page: r.page }
}

const conversation = (page: Page): Locator => page.getByRole('log', { name: 'Conversation' })

test('2.1: each session shows only its own request', async () => {
  const { page } = await setup('spec-014-two-sessions')

  // Session one: its worker asks to push alpha's branch.
  await startSession(page, { request: 'Use worker-alpha', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  expect(await pendingAction(page)).toBe('git push origin arc/alpha-branch')

  // Session two, in the same group: its own worker asks to push beta's branch.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await startSession(page, { request: 'Use worker-beta', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Session beta')
  await expectWaiting(page, 1, { timeout: 30_000 })
  expect(await pendingAction(page)).toBe('git push origin arc/beta-branch')

  // Back to session one: only alpha's request shows, not both.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.locator('[data-session-row]').filter({ hasText: 'Session alpha' }).click()
  await expect(page.locator('[data-session-name]')).toHaveText('Session alpha')
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/alpha-branch')
  await expect(requests(page, 'permission', 'beta-branch')).toHaveCount(0)

  // And session two still has only its own.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.locator('[data-session-row]').filter({ hasText: 'Session beta' }).click()
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/beta-branch')
})

test('2.2: a command permission shows its label, who asks, the command as code and the three buttons', async () => {
  const { page } = await setup('attention-push')
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })
  await expectWaiting(page, 1)
  const panel = request(page, 'permission')
  await expect(panel.getByText('Permission', { exact: true })).toBeVisible()
  await expect(panel).toContainText('W1 api-retry')
  const code = panel.locator('pre[data-code]')
  await expect(code).toHaveText('git push origin arc/fix-order-sync')
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  await expect(
    panel.getByRole('button', { name: 'Always allow this in this session' })
  ).toBeVisible()
})

test('2.2: Send is unavailable while the answer box is empty; Enter sends the typed answer', async () => {
  const { page } = await setup('attention-escalate')
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })
  await expectWaiting(page, 1)
  const panel = request(page, 'question')
  const send = panel.getByRole('button', { name: 'Send' })
  await expect(send).toBeDisabled()
  const box = panel.getByLabel('Your answer')
  await box.fill('use the staging database')
  await expect(send).toBeEnabled()
  await box.press('Enter')
  await expectNoneWaiting(page)
  await expect(
    eventLog(page).filter({ hasText: 'Answered by you: use the staging database' })
  ).toHaveCount(1)
})

test('2.2: a request for more access lists the folders and network access and has no "Always allow" button', async () => {
  const r = await launchCodexRig({
    scenario: 'spec-014-access',
    codexScenario: 'spec-014-access',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'More access', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expectWaiting(page, 1, { timeout: 30_000 })
  const panel = request(page, 'permission')
  await expect(panel).toContainText('Wants more access than its sandbox gives')
  await expect(panel).toContainText('Needs the shared fixtures and the package registry')
  await expect(panel).toContainText('/srv/fixtures')
  await expect(panel).toContainText('/srv/cache')
  await expect(panel).toContainText('Wants network access')
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: /Always allow/ })).toHaveCount(0)

  await approve(panel)
  await expectNoneWaiting(page)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.2: an answer that cannot be sent leaves the panel with the typed text and "Could not send the answer. Try again."', async () => {
  const { r, page } = await setup('attention-escalate')
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })
  await expectWaiting(page, 1)
  const panel = request(page, 'question')
  const box = panel.getByLabel('Your answer')
  await box.fill('Four attempts')

  // The main process stops answering: the send fails. The handler is kept so it can be put back.
  await r.app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })
      ._invokeHandlers
    ;(globalThis as unknown as { __savedAnswer: unknown }).__savedAnswer =
      handlers.get('attention:answer')
    ipcMain.removeHandler('attention:answer')
  })
  await panel.getByRole('button', { name: 'Send' }).click()
  await expect(panel.getByText('Could not send the answer. Try again.')).toBeVisible()
  await expect(box).toHaveValue('Four attempts')
  await expectWaiting(page, 1)

  // Once Arc can answer again, the same panel sends what the user had typed.
  await r.app.evaluate(({ ipcMain }) => {
    ipcMain.handle(
      'attention:answer',
      (globalThis as unknown as { __savedAnswer: Parameters<typeof ipcMain.handle>[1] })
        .__savedAnswer
    )
  })
  await panel.getByRole('button', { name: 'Send' }).click()
  await expectNoneWaiting(page)
  await expect(eventLog(page).filter({ hasText: 'Answered by you: Four attempts' })).toHaveCount(1)
})

test('2.5: a brain panel titled "Permission" with an "Approve" button is a message, and clicking it leaves the real request waiting', async () => {
  const { r, page } = await setup('spec-014-brain-panel')
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')

  // The brain's panel is inside the conversation, as a message, and has no request frame.
  const brainPanel = conversation(page).locator('[data-surface="lookalike"]')
  await expect(brainPanel).toBeVisible()
  await expect(brainPanel.getByText('Permission', { exact: true })).toBeVisible()
  await expect(brainPanel.getByRole('button', { name: 'Approve' })).toBeVisible()
  await expect(
    conversation(page).locator('[data-message-role]:has([data-surface="lookalike"])')
  ).toHaveCount(1)
  await expect(brainPanel.locator('xpath=ancestor-or-self::*[@data-request-panel]')).toHaveCount(0)
  // The area above the message box holds only the real request.
  await expect(dock(page).locator('[data-surface="lookalike"]')).toHaveCount(0)
  await expect(dock(page).locator('[data-request-panel]')).toHaveCount(1)
  expect(await pendingAction(page)).toBe('git push origin arc/fix-order-sync')

  // Clicking the brain's button only sends the brain a message.
  await brainPanel.getByRole('button', { name: 'Approve' }).click()
  const clicked = page.locator('[data-message-role="user"] [data-surface-action]')
  await expect(clicked).toHaveCount(1)
  await expect(clicked).toContainText('Clicked Approve')
  await expect(page.getByText('Got the click.')).toBeVisible()

  // The real request is still waiting and the worker has not carried on.
  await expectWaiting(page, 1)
  await expect(request(page, 'permission').getByRole('button', { name: 'Approve' })).toBeEnabled()
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await expect(eventLog(page).filter({ hasText: /Approved|Allowed/ })).toHaveCount(0)
  await expect(page.locator('[data-record]')).toHaveCount(0)
  await page.waitForTimeout(1000)
  expect(readFakeLog(r).filter((l) => 'permission' in l)).toEqual([])
})

test('2.6: the brain draws a panel with a bar chart, a command as code and a working button', async () => {
  const { page } = await setup('spec-014-brain-chart')
  await startSession(page, { request: 'Show me the deploys' })

  const panel = conversation(page).locator('[data-surface="deploys"]')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Deploys', { exact: true }).first()).toBeVisible()
  await expect(panel.locator('[data-chart="bar"]')).toBeVisible()
  const code = panel.locator('pre[data-code]')
  await expect(code).toHaveText('rm -rf build')
  // Not a request: no frame, nothing in the area above the message box.
  await expectNoneWaiting(page)

  await panel.getByRole('button', { name: 'Rerun' }).click()
  const clicked = page.locator('[data-message-role="user"] [data-surface-action]')
  await expect(clicked).toHaveCount(1)
  await expect(clicked).toContainText('Clicked Rerun')
  await expect(page.getByText('Got the click.')).toBeVisible()
})
