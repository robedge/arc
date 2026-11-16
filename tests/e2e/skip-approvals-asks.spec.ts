// @spec: 015-skip-all-approvals
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { FAKE_MCP, launchCodexRig } from './codex-rig'
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
  deny,
  expectNoneWaiting,
  expectWaiting,
  pendingAction,
  permissionFrom,
  request
} from './attention-rig'

/**
 * Spec 015 slice 2: what still asks while Skip all approvals is on. A tool server's publish (a pull request) goes
 * to the user and the brain cannot approve it, a worker the user stepped in on asks in its terminal and is
 * approved after hand-back, and the brain is told with a note in front of its next message.
 */

let rig: Rig | CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const skipSwitch = (page: Page) => page.getByLabel('Skip all approvals', { exact: true })
const skipDialog = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const marker = (page: Page) => page.locator('[data-skip-approvals-on]')

async function turnSkipOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approvals' }).click()
  await skipSwitch(page).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(marker(page)).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Approvals', exact: true })).toHaveCount(0)
}

/** Every stdin record of the fake CLI processes, as text. */
function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

function mcpResult(r: Rig, tool: string): { isError: boolean; text: string } | undefined {
  const rec = readFakeLog(r).find((l) => {
    const m = l['mcpResult'] as { tool?: string } | undefined
    return m?.tool === tool
  })
  return rec ? (rec['mcpResult'] as { isError: boolean; text: string }) : undefined
}

function permissionBehaviors(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'permission' in l)
    .map((l) => (l['permission'] as { behavior: string }).behavior)
}

const NOTE_ON = '[Arc] Skip all approvals is on.'

test('015 2.4: a tool-server change runs with the event text; opening a pull request still docks, and the brain cannot approve it', async () => {
  const r = await launchCodexRig({
    scenario: 'skip-mcp',
    repos: [{ name: 'api' }],
    homeFiles: () => ({
      '.claude.json': JSON.stringify({
        mcpServers: {
          figma: {
            command: process.execPath,
            args: [FAKE_MCP],
            env: { FAKE_MCP_TOOLS: JSON.stringify({ create_pull_request: {} }) }
          }
        }
      })
    })
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma and open a pull request', mode: 'Autonomous' })

  // The destructive command waits for the user; turning skip on approves it at once.
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('rm -rf build')
  await turnSkipOn(page)
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): rm -rf build' })
  ).toHaveCount(1)

  // The changing tool that does not publish runs with the event text, and nothing is docked for it.
  await expect(
    eventLog(page).filter({ hasText: /Approved \(skipping approvals\): .*figma_write/ })
  ).toHaveCount(1)

  // The pull request waits in the dock, marked as from the worker.
  await expectWaiting(page, 1)
  const docked = permissionFrom(page, /W1/)
  await expect(docked).toBeVisible()
  await expect(docked).toContainText('create_pull_request')
  expect(await pendingAction(page)).toContain('pr-1')
  await expect(
    eventLog(page).filter({ hasText: /Approved \(skipping approvals\): .*create_pull_request/ })
  ).toHaveCount(0)

  // The brain tried to approve it and was refused: only the user decides.
  await expect
    .poll(() => mcpResult(r, 'resolve_request')?.text ?? '', { timeout: 20_000 })
    .toContain('policy_requires_user')
  expect(mcpResult(r, 'resolve_request')?.isError).toBe(true)
  // The note that skip is on rode in front of the brain's next message (the pull request's).
  expect(stdinTexts(r).some((t) => t.includes(NOTE_ON) && t.includes('create_pull_request'))).toBe(
    true
  )
  // The request is still waiting after the refusal: only the rm and the figma_write were allowed so far.
  await expectWaiting(page, 1)
  expect(permissionBehaviors(r)).toEqual(['allow', 'allow'])

  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)
  await expect.poll(() => permissionBehaviors(r)).toEqual(['allow', 'allow', 'deny'])
})

const W1 = 'W1 · api-retry'
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Conversation' })
const input = (page: Page) => page.getByLabel(`Message to ${W1}`)
const pinned = (page: Page) => page.getByRole('group', { name: 'Needs your answer' })

test('015 2.5: a stepped-in worker asks in its terminal, and its request is approved after hand-back, then the next command runs unasked', async () => {
  const r = await launchRig({ scenario: 'skip-step-in', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  await expect(workerCard(page, W1)).toHaveAttribute('data-worker-card', 'working')
  await turnSkipOn(page)

  await workerCard(page, W1).getByRole('button').first().click()
  await page.getByRole('button', { name: 'Step in', exact: true }).click()
  await expect(input(page)).toBeVisible()
  await input(page).fill('Please run the cleanup')
  await input(page).press('Enter')

  // The destructive command asks in the terminal bar, not in the dock, and has not run.
  await expect(pinned(page).locator('pre[data-code]').first()).toHaveText('rm -rf build')
  await expect(eventLog(page).filter({ hasText: 'Approved (skipping approvals)' })).toHaveCount(0)
  await tabs(page)
    .getByRole('tab', { name: /^Brain/ })
    .click()
  await expectNoneWaiting(page)
  await tabs(page).getByRole('tab', { name: W1 }).click()
  expect(permissionBehaviors(r)).toEqual([])

  // The brain's next message carried the note that skip is on.
  await expect.poll(() => stdinTexts(r).some((t) => t.includes(NOTE_ON))).toBe(true)

  // Hand back: the waiting request is approved with the event text; the next command runs with no request.
  await page.getByRole('button', { name: 'Hand back', exact: true }).click()
  await expect(pinned(page)).toHaveCount(0)
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): rm -rf build' })
  ).toHaveCount(1)
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): rm -rf dist' })
  ).toHaveCount(1)
  await tabs(page)
    .getByRole('tab', { name: /^Brain/ })
    .click()
  await expectNoneWaiting(page)
  // Hand-back also replaces the process (skip changed while the user was in control, spec 015 slice 7), so the
  // first process, stopped as its request was approved, never logged its answer; the second one logged its own.
  await expect.poll(() => permissionBehaviors(r)).toEqual(['allow'])
})

/** Starts a session with Skip all approvals on from the first message, through the New Session dialog. */
async function startSkipping(
  page: Page,
  request: string,
  mode: 'Autonomous' | undefined
): Promise<void> {
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Request').fill(request)
  if (mode) await dialog.getByLabel(mode, { exact: false }).check()
  await dialog.getByLabel('Skip all approvals', { exact: true }).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(marker(page)).toBeVisible()
}

test('015 2.4: a worker question under skip still goes to the brain and, unanswered, reaches the dock', async () => {
  const r = await launchRig({ scenario: 'attention-escalate', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSkipping(page, 'Add retry', 'Autonomous')

  // The brain was asked, passed the question on, and it waits for the user in the dock.
  await expectWaiting(page, 1)
  const question = request(page, 'question')
  await expect(question).toContainText('How many retries should the client make?')
  expect(stdinTexts(r).some((t) => t.includes('asks:') && t.includes('How many retries'))).toBe(
    true
  )
  await expect(eventLog(page).filter({ hasText: 'Approved (skipping approvals)' })).toHaveCount(0)
})

test('015 2.4: a Plan-first session under skip shows the plan and starts nothing until it is approved', async () => {
  const r = await launchRig({ scenario: 'plan-first', repos: [{ name: 'api' }, { name: 'web' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!, r.repos['web']!])
  await startSkipping(page, 'Add retries and docs', undefined)

  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan).toBeVisible()
  await expect(plan.locator('[data-plan-worker]')).toHaveCount(2)
  // Skip all approvals covers permissions, not plans: the early spawn was refused and nothing runs.
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)

  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('[data-plan-card="approved"]')).toBeVisible()
  await expect(page.locator('[data-worker-card]')).toHaveCount(2)
})

test('015 2.4: with Arc in the background, a skipped approval raises no notification and the push request raises one', async () => {
  const r = await launchRig({ scenario: 'skip-approvals', repos: [{ name: 'api' }] })
  rig = r
  const { page, app } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await app.evaluate(() => {
    ;(globalThis as unknown as { __e2e: { forceUnfocused: boolean } }).__e2e.forceUnfocused = true
  })
  const notified = (): Promise<number> =>
    app.evaluate(
      () =>
        (globalThis as unknown as { __e2e: { notifications: unknown[] } }).__e2e.notifications
          .length
    )
  await startSkipping(page, 'Run the skip-approvals checks', 'Autonomous')

  // Both destructive commands were approved by skip; the push is the first thing that waits.
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): rm -rf build' })
  ).toHaveCount(1)
  await expect(
    eventLog(page).filter({
      hasText: 'Approved (skipping approvals): rm -rf /Users/redgell/v9-outside/old'
    })
  ).toHaveCount(1)
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/skip')
  await expect.poll(notified).toBe(1)
  await page.waitForTimeout(1000)
  expect(await notified()).toBe(1)
})
