// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
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

async function setup(scenario: string) {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

async function openApprovals(page: Page) {
  await page.getByRole('button', { name: 'Approvals' }).click()
  return page.getByRole('dialog', { name: 'Approvals' })
}

async function pendingAction(page: Page): Promise<string> {
  await badge(page).click()
  const action = await attentionDialog(page).locator('[data-action]').first().innerText()
  return action.trim()
}

test('2.7: reads and temp writes need no request; Always allow, the rule, and removing it', async () => {
  const r = await setup('rules')
  const { page } = r
  await startSession(page, { request: 'Run the permission checks', mode: 'Autonomous' })

  // The first request is the write outside the working copy: the read and the /tmp write ran freely.
  await expect(badge(page)).toHaveCount(1)
  await expect(badge(page).locator('[data-count]')).toHaveText('1')
  expect(await pendingAction(page)).toBe('cp a.txt /Users/redgell/v9-outside/x1.txt')
  await expect(
    eventLog(page).filter({ hasText: /Approved by you|Allowed by your rule/ })
  ).toHaveCount(0)

  // Always allow: the worker resumes and the header lists the rule.
  await attentionDialog(page)
    .getByRole('button', { name: 'Always allow this in this session' })
    .click()
  await expect(badge(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approvals' })).toHaveText(/Approvals · 1/)

  // The next matching request is approved on its own, with no card.
  await expect(eventLog(page).filter({ hasText: /^.*Allowed by your rule: / })).toHaveCount(1)
  await expect(badge(page)).toHaveCount(0)

  // Removing the rule makes the next matching request ask again.
  const approvals = await openApprovals(page)
  await expect(approvals.locator('[data-allow-rule]')).toHaveCount(1)
  await approvals.getByRole('button', { name: /Remove rule/ }).click()
  await expect(approvals.locator('[data-allow-rule]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(badge(page)).toHaveCount(1, { timeout: 20_000 })
  expect(await pendingAction(page)).toBe('cp a.txt /Users/redgell/v9-outside/x3.txt')
})

test('2.7: a new rule also approves the matching requests already waiting', async () => {
  const r = await setup('rules-two')
  const { page } = r
  await startSession(page, { request: 'Two writers', mode: 'Autonomous' })

  await expect(badge(page).locator('[data-count]')).toHaveText('2')
  await badge(page).click()
  const dialog = attentionDialog(page)
  await dialog
    .getByRole('article')
    .first()
    .getByRole('button', { name: 'Always allow this in this session' })
    .click()
  await expect(badge(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Approvals' })).toHaveText(/Approvals · 1/)
  await expect(eventLog(page).filter({ hasText: 'Allowed by your rule' })).toHaveCount(1)
  await expect(workerCard(page, 'W1 · writer-one')).toHaveAttribute(
    'data-worker-card',
    /working|done|merged/
  )
  await expect(workerCard(page, 'W2 · writer-two')).toHaveAttribute(
    'data-worker-card',
    /working|done|merged/
  )
})

test('2.7: Auto-approve covers protected requests but pushes, PRs and MRs still ask', async () => {
  const r = await setup('auto')
  const { page } = r
  await startSession(page, { request: 'Run the auto-approve checks', mode: 'Autonomous' })

  // A request is waiting; turning Auto-approve on approves it.
  await expect(badge(page).locator('[data-count]')).toHaveText('1')
  const approvals = await openApprovals(page)
  await approvals.getByLabel('Auto-approve').check()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-auto-approve-on]')).toBeVisible()
  await expect(
    eventLog(page).filter({ hasText: 'Auto-approved: cp a.txt /Users/redgell/v9-outside/y1.txt' })
  ).toHaveCount(1)
  // The destructive command that follows is auto-approved as well, without a card.
  await expect(
    eventLog(page).filter({ hasText: 'Auto-approved: rm -rf /Users/redgell/v9-outside/old' })
  ).toHaveCount(1)

  // The push still asks.
  await expect(badge(page).locator('[data-count]')).toHaveText('1')
  expect(await pendingAction(page)).toBe('git push origin arc/auto')
  await attentionDialog(page).getByRole('button', { name: 'Deny' }).click()
  // So do a pull request and a merge request.
  await expect(badge(page)).toHaveCount(1)
  expect(await pendingAction(page)).toBe('gh pr create --fill')
  await attentionDialog(page).getByRole('button', { name: 'Deny' }).click()
  await expect(badge(page)).toHaveCount(1)
  expect(await pendingAction(page)).toBe('glab mr merge 12')
  await attentionDialog(page).getByRole('button', { name: 'Deny' }).click()
  await expect(badge(page)).toHaveCount(0)
})

test("2.7: the brain's shell: read freely, ask for changes, Auto-approve, push still asks", async () => {
  const r = await setup('brain-shell')
  const { page } = r
  await startSession(page, { request: 'Look at my checkout' })
  const brain = page.locator('[data-brain-card]')
  const input = page.getByPlaceholder('Message the brain')
  const send = async (text: string): Promise<void> => {
    await input.fill(text)
    await input.press('Enter')
  }
  await expect(page.getByText('Ready.').first()).toBeVisible()
  await expect(brain).toHaveAttribute('data-state', 'idle')

  // git diff runs without any approval.
  await send('DIFF-IT')
  await expect(page.getByText('Diff read without a request.')).toBeVisible()
  await expect(badge(page)).toHaveCount(0)

  // A commit goes to the user as from Brain; the brain card waits; Approve lets it run.
  await send('COMMIT-ONE')
  await expect(badge(page)).toHaveCount(1)
  await expect(brain).toHaveAttribute('data-state', 'waiting')
  await expect(brain.getByRole('status')).toHaveText('Waiting on you')
  await badge(page).click()
  const card = attentionDialog(page).getByRole('article', { name: 'Permission request from Brain' })
  await expect(card.locator('[data-action]')).toHaveText('git commit -am x')
  await expect(card.locator('[data-reason]')).toContainText(
    'may change files or git state in your checkouts'
  )
  await card.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByText('Committed after your approval.')).toBeVisible()
  await expect(badge(page)).toHaveCount(0)

  // Deny: the brain is told and carries on.
  await send('COMMIT-TWO')
  await badge(page).click()
  await attentionDialog(page).getByRole('button', { name: 'Deny' }).click()
  await expect(page.getByText('Carrying on after the refusal.')).toBeVisible()
  await expect(badge(page)).toHaveCount(0)

  // Auto-approve: the commit runs without a card, the push still asks.
  const approvals = await openApprovals(page)
  await approvals.getByLabel('Auto-approve').check()
  await page.keyboard.press('Escape')
  await send('AUTO-GO')
  await expect(page.getByText('Committed without a card.')).toBeVisible()
  await expect(badge(page)).toHaveCount(1)
  expect(await pendingAction(page)).toBe('git push origin main')
  await expect(
    attentionDialog(page).getByRole('article', { name: 'Permission request from Brain' })
  ).toBeVisible()
})
