// @spec: 003-sessions-brain-and-workers
// @regression
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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
import {
  alwaysAllow,
  choice,
  submitChoices,
  approve,
  deny,
  expectNoneWaiting,
  expectWaiting,
  pendingAction,
  permissionAction,
  permissionFrom,
  request
} from './attention-rig'

const screenshotsDir = join(process.cwd(), 'docs', 'screenshots')

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(scenario: string) {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

async function openApprovals(page: Page) {
  await page.getByRole('button', { name: 'Approvals', exact: true }).click()
  return page.getByRole('dialog', { name: 'Approvals', exact: true })
}

test('2.7: reads and temp writes need no request; Always allow, the rule, and removing it', async () => {
  const r = await setup('rules')
  const { page } = r
  await startSession(page, { request: 'Run the permission checks', mode: 'Autonomous' })

  // The first request is the write outside the working copy: the read and the /tmp write ran freely.
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('cp a.txt /Users/redgell/v9-outside/x1.txt')
  await expect(
    eventLog(page).filter({ hasText: /Approved by you|Allowed by your rule/ })
  ).toHaveCount(0)

  // Always allow: the worker resumes and the header lists the rule.
  await alwaysAllow(request(page, 'permission'))
  await expectNoneWaiting(page)
  await expect(page.getByRole('button', { name: 'Approvals' })).toHaveText(/Approvals · 1/)

  // The next matching request is approved on its own, with no card.
  await expect(eventLog(page).filter({ hasText: /^.*Allowed by your rule: / })).toHaveCount(1)
  await expectNoneWaiting(page)

  // Removing the rule makes the next matching request ask again.
  const approvals = await openApprovals(page)
  await expect(approvals.locator('[data-allow-rule]')).toHaveCount(1)
  await approvals.getByRole('button', { name: /Remove rule/ }).click()
  await expect(approvals.locator('[data-allow-rule]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('cp a.txt /Users/redgell/v9-outside/x3.txt')
})

test('2.7: a new rule also approves the matching requests already waiting', async () => {
  const r = await setup('rules-two')
  const { page } = r
  await startSession(page, { request: 'Two writers', mode: 'Autonomous' })

  await expectWaiting(page, 2)
  await alwaysAllow(request(page, 'permission'))
  await expectNoneWaiting(page)
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
  await expectWaiting(page, 1)
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
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/auto')
  await deny(request(page, 'permission'))
  // So do a pull request and a merge request.
  await expectWaiting(page, 1)
  await expect(permissionAction(request(page, 'permission'))).toHaveText('gh pr create --fill')
  await deny(request(page, 'permission'))
  await expectWaiting(page, 1)
  await expect(permissionAction(request(page, 'permission'))).toHaveText('glab mr merge 12')
  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)
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
  await expectNoneWaiting(page)

  // A commit goes to the user as from Brain; the brain card waits; Approve lets it run.
  await send('COMMIT-ONE')
  await expectWaiting(page, 1)
  await expect(brain).toHaveAttribute('data-state', 'waiting')
  await expect(brain.getByRole('status')).toHaveText('Waiting on you')
  const card = permissionFrom(page, 'Brain')
  await expect(permissionAction(card)).toHaveText('git commit -am x')
  await expect(card).toContainText('may change files or git state in your checkouts')
  await approve(card)
  await expect(page.getByText('Committed after your approval.')).toBeVisible()
  await expectNoneWaiting(page)

  // Deny: the brain is told and carries on.
  await send('COMMIT-TWO')
  await deny(request(page, 'permission'))
  await expect(page.getByText('Carrying on after the refusal.')).toBeVisible()
  await expectNoneWaiting(page)

  // Auto-approve: the commit runs without a card, the push still asks.
  const approvals = await openApprovals(page)
  await approvals.getByLabel('Auto-approve').check()
  await page.keyboard.press('Escape')
  await send('AUTO-GO')
  await expect(page.getByText('Committed without a card.')).toBeVisible()
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin main')
  await expect(permissionFrom(page, 'Brain')).toBeVisible()
})

// Skip all approvals (spec 015, slice 1).
const skipSwitch = (page: Page) => page.getByLabel('Skip all approvals', { exact: true })
const skipDialog = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const marker = (page: Page) => page.locator('[data-skip-approvals-on]')

async function startSkipSession(): Promise<Page> {
  const r = await setup('skip-approvals')
  await startSession(r.page, { request: 'Run the skip-approvals checks', mode: 'Autonomous' })
  await expectWaiting(r.page, 1)
  expect(await pendingAction(r.page)).toBe('rm -rf build')
  return r.page
}

async function confirmSkip(page: Page): Promise<void> {
  const approvals = await openApprovals(page)
  await skipSwitch(page).click()
  await expect(skipDialog(page)).toBeVisible()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(marker(page)).toBeVisible()
  await expect(approvals).toHaveCount(0)
}

test('015 2.1: the warning dialog; Cancel, Escape and Enter leave it off; confirming shows the marker and covers Auto-approve', async () => {
  const page = await startSkipSession()
  const approvals = await openApprovals(page)
  await expect(skipSwitch(page)).not.toBeChecked()

  // Turning it on opens the dialog and closes the menu so the warning is never under it.
  await skipSwitch(page).click()
  await expect(skipDialog(page)).toBeVisible()
  await expect(skipDialog(page)).toContainText('Arc will still ask before pushing a branch')
  await expect(approvals).toHaveCount(0)
  // Cancel is the focused default.
  await expect(skipDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()

  // Cancel leaves the switch off.
  await skipDialog(page).getByRole('button', { name: 'Cancel' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await openApprovals(page)
  await expect(skipSwitch(page)).not.toBeChecked()

  // Enter with Cancel focused cancels.
  await skipSwitch(page).click()
  await expect(skipDialog(page).getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(marker(page)).toHaveCount(0)

  // Escape cancels the dialog.
  await openApprovals(page)
  await skipSwitch(page).click()
  await expect(skipDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(marker(page)).toHaveCount(0)
  await openApprovals(page)
  await expect(skipSwitch(page)).not.toBeChecked()
  // Nothing was approved by any of that.
  await expectWaiting(page, 1)
  await expect(eventLog(page).filter({ hasText: 'Approved (skipping approvals)' })).toHaveCount(0)

  // Confirm.
  await skipSwitch(page).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(marker(page)).toBeVisible()
  await expect(marker(page)).toContainText('Skipping approvals')
  await expect(approvals).toHaveCount(0)
  await openApprovals(page)
  await expect(skipSwitch(page)).toBeChecked()
  await expect(page.getByLabel('Auto-approve', { exact: true })).toBeChecked()
  await expect(page.getByLabel('Auto-approve', { exact: true })).toBeDisabled()
  await expect(page.getByText('Covered by Skip all approvals').first()).toBeAttached()
  await page.keyboard.press('Escape')

  await mkdir(screenshotsDir, { recursive: true })
  await marker(page)
    .locator('xpath=..')
    .screenshot({ path: join(screenshotsDir, '015-skip-approvals-header-marker.png') })
})

test('015 2.3-2.5: confirming sweeps the waiting request; later commands run with the event text; pushes and questions still ask; turning off asks again', async () => {
  const page = await startSkipSession()
  await confirmSkip(page)

  // The waiting `rm -rf build` left the dock at once, with the event text.
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): rm -rf build' })
  ).toHaveCount(1)
  // The next destructive command runs with no request.
  await expect(
    eventLog(page).filter({
      hasText: 'Approved (skipping approvals): rm -rf /Users/redgell/v9-outside/old'
    })
  ).toHaveCount(1)
  // The push still asks.
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/skip')
  await deny(request(page, 'permission'))

  // The worker's question still reaches the dock.
  await expectWaiting(page, 1)
  const question = request(page, 'question')
  await expect(question).toContainText('Which target should the cleanup use?')

  // Click the marker, Turn off: it goes without the dialog for Skip all approvals.
  await marker(page).click()
  const confirm = page.getByRole('dialog', { name: 'Turn Skip all approvals off?' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Turn off' }).click()
  await expect(marker(page)).toHaveCount(0)

  // The next destructive command asks again.
  await choice(question, 'Dist').click()
  await submitChoices(question)
  await expect(request(page, 'permission')).toBeVisible()
  expect(await pendingAction(page)).toBe('rm -rf dist')
  await expect(
    eventLog(page)
      .filter({ hasText: 'rm -rf dist' })
      .filter({ hasText: 'Approved (skipping approvals)' })
  ).toHaveCount(0)
})
