// @spec: 014-inline-needs-attention
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { FAKE_MCP, launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  readFakeLog,
  sendToBrain,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  alwaysAllow,
  approve,
  deny,
  dock,
  dockHeading,
  answerQuestion,
  expectNoDialog,
  expectNoneWaiting,
  expectWaiting,
  permissionFrom,
  pendingAction,
  request,
  requests
} from './attention-rig'

/**
 * Spec 014 slice 3: waiting permission requests dock above the message box. These checks cover what the migrated
 * approval and attention specs do not: the layout of the dock (height cap, scrolling, staying in view), the long
 * tool arguments, the message box while a request waits, and the missing header button and dialog.
 */

let rig: Rig | CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(scenario: string, limit?: number): Promise<{ r: Rig; page: Page }> {
  const r = await launchRig({ scenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Dock checks', mode: 'Autonomous', limit })
  return { r, page: r.page }
}

const box = async (
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

test('3.1: a worker command request shows "Needs attention · 1" and a Permission panel above the message box', async () => {
  const { page } = await setup('attention-push')
  // No click opens anything: the heading and the panel are already there.
  await expectWaiting(page, 1)
  await expect(dockHeading(page)).toHaveAccessibleName('Needs attention · 1')
  const panel = request(page, 'permission')
  await expect(panel).toBeVisible()
  await expect(page.getByRole('article', { name: /Permission request from W1/ })).toBeVisible()
  const dockBox = await box(dock(page))
  const inputBox = await box(page.getByPlaceholder('Message the brain'))
  expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(inputBox.y)
})

test('3.2a: Approve lets the worker carry on and the dock disappears', async () => {
  const { page } = await setup('attention-push')
  await expectWaiting(page, 1)
  await approve(request(page, 'permission'))
  await expectNoneWaiting(page)
  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    { timeout: 20_000 }
  )
})

test('3.2b: Deny tells the worker it was denied', async () => {
  const { r, page } = await setup('attention-brew')
  await expectWaiting(page, 1)
  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)
  // The fake CLI logs the answer the permission tool gave: the worker was told no.
  await expect
    .poll(() =>
      readFakeLog(r).some((l) => {
        const p = l['permission'] as { input?: { command?: string }; behavior?: string } | undefined
        return p?.input?.command === 'brew install jq' && p.behavior === 'deny'
      })
    )
    .toBe(true)
  await expect(workerCard(page, 'W1 · tooling')).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    {
      timeout: 20_000
    }
  )
})

test('3.2c: Always allow means the same action is not asked again in that session', async () => {
  const { r, page } = await setup('rules')
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('cp a.txt /Users/redgell/v9-outside/x1.txt')
  await alwaysAllow(request(page, 'permission'))
  await expectNoneWaiting(page)
  // The next write of the same kind runs on the rule: logged as allowed, never docked.
  await expect(eventLog(page).filter({ hasText: 'Allowed by your rule' })).toHaveCount(1)
  await page.waitForTimeout(1000)
  await expectNoneWaiting(page)
  const x2 = readFakeLog(r).filter(
    (l) =>
      (l['permission'] as { input?: { command?: string } } | undefined)?.input?.command ===
      'cp a.txt /Users/redgell/v9-outside/x2.txt'
  )
  expect(x2.length).toBeGreaterThan(0)
})

test('3.3: a tool request with more than 10 lines of arguments shows "Show more" and then every line with "Show less"', async () => {
  const r = await launchCodexRig({
    scenario: 'dock-mcp',
    repos: [{ name: 'api' }],
    homeFiles: () => ({
      '.claude.json': JSON.stringify({
        mcpServers: { figma: { command: process.execPath, args: [FAKE_MCP] } }
      })
    })
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma', mode: 'Autonomous' })

  await expectWaiting(page, 1)
  const panel = request(page, 'permission')
  const args = panel.locator('pre[data-code]').first()
  await expect(args).toBeVisible()
  const more = panel.getByRole('button', { name: 'Show more' })
  await expect(more).toBeVisible()
  await expect(args).not.toContainText('"field12"')
  await more.click()
  await expect(args).toContainText('"field01"')
  await expect(args).toContainText('"field12"')
  await expect(panel.getByRole('button', { name: 'Show less' })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Show more' })).toHaveCount(0)
})

test('3.4: a second request makes the heading read "Needs attention · 2" with its panel below the first', async () => {
  const { page } = await setup('rules-two')
  await expectWaiting(page, 2)
  await expect(dockHeading(page)).toHaveAccessibleName('Needs attention · 2')
  const panels = requests(page, 'permission')
  const first = await box(panels.nth(0))
  const second = await box(panels.nth(1))
  expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1)
})

test('3.5: scrolling the conversation up to older messages leaves the waiting panel in view above the message box', async () => {
  const { page } = await setup('dock-many', 5)
  await expectWaiting(page, 5, { timeout: 30_000 })
  const conversation = page.getByRole('log', { name: 'Conversation' })
  await expect(page.getByText('Older note 1.')).toBeAttached()
  // Scroll to the oldest message: the list really moves.
  await expect
    .poll(async () => {
      await conversation.evaluate((el) => {
        el.scrollTop = 0
      })
      return conversation.evaluate((el) => el.scrollTop)
    })
    .toBe(0)
  // At 1200x800 the first panel takes about four fifths of the conversation, so the list shows little
  // more than its top edge: the oldest message sits at the top of the list rather than in full view.
  await expect(page.getByText('Starting out.')).toBeAttached()
  await expect(page.getByText('Older note 12.')).not.toBeInViewport()
  // The panel stays in the viewport, above the message box.
  const panel = request(page, 'permission')
  await expect(panel).toBeInViewport()
  const dockBox = await box(dock(page))
  const inputBox = await box(page.getByPlaceholder('Message the brain'))
  expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(inputBox.y)
  // It sits outside the scrolling list.
  expect(
    await conversation.evaluate((el) =>
      el.contains(document.querySelector('[data-attention-dock]'))
    )
  ).toBe(false)
})

test('3.6: with a request waiting, a typed message reaches the brain and the request still waits', async () => {
  const { r, page } = await setup('dock-many', 5)
  await expectWaiting(page, 5, { timeout: 30_000 })
  await sendToBrain(page, 'DOCK-PING')
  await expect(page.getByText('Heard you while requests wait.')).toBeVisible()
  expect(
    readFakeLog(r).some(
      (l) => l['stdin'] !== undefined && JSON.stringify(l['stdin']).includes('DOCK-PING')
    )
  ).toBe(true)
  await expectWaiting(page, 5)
})

test('3.7: the session header has no "Needs attention" button and no dialog exists', async () => {
  const { page } = await setup('attention-push')
  await expectWaiting(page, 1)
  const header = page.locator('[data-header-controls]').locator('xpath=..')
  await expect(header).toBeVisible()
  await expect(header.getByRole('button', { name: /Needs attention/ })).toHaveCount(0)
  await expect(header).not.toContainText('Needs attention')
  await expectNoDialog(page)
  // The only "Needs attention" on the page is the dock heading.
  await expect(page.getByRole('heading', { name: /Needs attention/ })).toHaveCount(1)
  await expect(dock(page).getByRole('heading')).toHaveCount(1)
})

test('3.8: with five requests the first panel shows in full, the dock stays within its height rule and the rest scrolls', async () => {
  const { page } = await setup('dock-many', 5)
  await expectWaiting(page, 5, { timeout: 30_000 })
  const region = page.locator('[data-dock-region]')
  const parent = await box(region.locator('xpath=..'))
  const dockBox = await box(dock(page))
  const list = dock(page).locator('[data-attention-list]')
  await list.evaluate((el) => {
    el.scrollTop = 0
  })
  const first = requests(page, 'permission').first()
  const heading = await box(dockHeading(page))
  const firstBox = await box(first)
  // At most max(half the conversation, heading + first panel + paddings), and never more than 80%.
  const needed = heading.height + firstBox.height + 40
  expect(dockBox.height).toBeLessThanOrEqual(Math.max(parent.height / 2, needed) + 1)
  expect(dockBox.height).toBeLessThanOrEqual(parent.height * 0.8 + 1)
  // The first panel is whole inside the dock with its list not scrolled: its Approve button is in view.
  const approve = first.getByRole('button', { name: 'Approve', exact: true })
  await expect(approve).toBeInViewport()
  const listBox = await box(list)
  const approveBox = await box(approve)
  expect(approveBox.y).toBeGreaterThanOrEqual(listBox.y - 1)
  expect(approveBox.y + approveBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
  expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
  // The panels together are taller than the dock, so its list scrolls and the last panel can be reached.
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const last = requests(page, 'permission').last()
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight
  })
  const lastBox = await box(last)
  const listAfter = await box(list)
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(listAfter.y + listAfter.height + 1)
  await expect(last.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport()
  expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('3.9: at the e2e window size a single permission request shows Approve and Deny without any scrolling', async () => {
  const { page } = await setup('attention-push')
  await expectWaiting(page, 1)
  const panel = request(page, 'permission')
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport()
  await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeInViewport()
  const list = dock(page).locator('[data-attention-list]')
  const listBox = await box(list)
  for (const name of ['Approve', 'Deny']) {
    const b = await box(panel.getByRole('button', { name, exact: true }))
    expect(b.y).toBeGreaterThanOrEqual(listBox.y - 1)
    expect(b.y + b.height).toBeLessThanOrEqual(listBox.y + listBox.height + 1)
  }
  expect(await list.evaluate((el) => el.scrollTop)).toBe(0)
  expect(await list.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true)
})

test('4.1: a plain question is answered by typing and pressing Enter', async () => {
  const { page } = await setup('attention-escalate')
  await expectWaiting(page, 1)
  const panel = request(page, 'question')
  await expect(panel.getByText('How many retries should the client make?')).toBeVisible()
  await panel.getByLabel('Your answer').fill('Four attempts')
  await panel.getByLabel('Your answer').press('Enter')
  await expectNoneWaiting(page)
  await expect(eventLog(page).filter({ hasText: 'Answered by you: Four attempts' })).toHaveCount(1)
})

test('4.2: a half-typed answer in a question panel survives another request arriving', async () => {
  const { page } = await setup('dock-typed', 2)
  await expectWaiting(page, 1, { timeout: 30_000 })
  const panel = request(page, 'question')
  await panel.getByLabel('Your answer').fill('Four att')

  await sendToBrain(page, 'GO-SECOND')
  await expectWaiting(page, 2, { timeout: 30_000 })
  await expect(requests(page, 'permission')).toHaveCount(1)
  await expect(request(page, 'question').getByLabel('Your answer')).toHaveValue('Four att')

  // The finished sentence still goes out as one answer.
  await answerQuestion(request(page, 'question'), 'Four attempts')
  await expectWaiting(page, 1)
  await expect(eventLog(page).filter({ hasText: 'Answered by you: Four attempts' })).toHaveCount(1)
})

const BRAIN_NAME = /^Brain, 1 waiting$/
const brainTab = (page: Page): Locator => page.locator('#tab-brain')
const highlighted = (page: Page): Locator => page.locator('[data-request-panel][data-highlight]')
const foldButton = (page: Page): Locator => page.locator('[data-attention-heading] button')
const list = (page: Page): Locator => dock(page).locator('[data-attention-list]')

test('5.1: the heading folds the dock to one line and unfolds it with a typed answer still in its box', async () => {
  const { page } = await setup('dock-typed', 2)
  await expectWaiting(page, 1, { timeout: 30_000 })
  await request(page, 'question').getByLabel('Your answer').fill('Four att')
  await sendToBrain(page, 'GO-SECOND')
  await expectWaiting(page, 2, { timeout: 30_000 })

  await dockHeading(page).getByRole('button').click()
  await expect(foldButton(page)).toHaveAttribute('aria-expanded', 'false')
  await expect(dockHeading(page)).toHaveAccessibleName('Needs attention · 2')
  await expect(list(page)).toBeHidden()
  await expect(dock(page).locator('article[data-kind]').first()).not.toBeVisible()

  await dockHeading(page).getByRole('button').click()
  await expect(foldButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(request(page, 'permission')).toBeVisible()
  await expect(request(page, 'question')).toBeVisible()
  await expect(request(page, 'question').getByLabel('Your answer')).toHaveValue('Four att')
})

test('5.2: a new request unfolds a folded dock and every waiting request shows', async () => {
  const { page } = await setup('dock-typed', 2)
  await expectWaiting(page, 1, { timeout: 30_000 })
  await dockHeading(page).getByRole('button').click()
  await expect(list(page)).toBeHidden()

  await sendToBrain(page, 'GO-SECOND')
  await expectWaiting(page, 2, { timeout: 30_000 })
  await expect(foldButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(list(page)).toBeVisible()
  await expect(request(page, 'question')).toBeVisible()
  await expect(request(page, 'permission')).toBeVisible()
})

test('5.3: with a worker tab in front the Brain tab reads "Brain, 1 waiting" and clicking it shows the panel', async () => {
  const { page } = await setup('dock-tab')
  // The worker is quiet, so its card opens the terminal tab; the request comes a few seconds later.
  await workerCard(page, 'W1 · api-retry').getByRole('button').first().click()
  await expect(
    page.getByRole('tablist', { name: 'Conversation' }).getByRole('tab', { name: 'W1 · api-retry' })
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tab', { name: 'Brain, 1 waiting' })).toBeVisible({ timeout: 30_000 })
  await expect(brainTab(page).locator('[data-attention-count]')).toBeVisible()

  await page.getByRole('tab', { name: 'Brain, 1 waiting' }).click()
  await expectWaiting(page, 1)
  await expect(request(page, 'permission')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Brain', exact: true })).toBeVisible()
  await expect(brainTab(page).locator('[data-attention-count]')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: BRAIN_NAME })).toHaveCount(0)
})

test("5.4: clicking an amber worker card shows that worker's panel highlighted, with no dialog, and the highlight fades", async () => {
  const { page } = await setup('rules-two')
  await expectWaiting(page, 2, { timeout: 30_000 })
  await workerCard(page, 'W2 · writer-two').getByRole('button').first().click()
  const target = permissionFrom(page, 'W2')
  await expect(target).toBeVisible()
  await expect(target).toHaveAttribute('data-highlight', /.*/)
  await expect(highlighted(page)).toHaveCount(1)
  await expect(target).toBeInViewport()
  await expectNoDialog(page)
  await expect(highlighted(page)).toHaveCount(0, { timeout: 3_000 })
})

test("5.5: a notification click shows that request's panel highlighted, with no dialog", async () => {
  const r = await launchRig({ scenario: 'attention-escalate', repos: [{ name: 'api' }] })
  rig = r
  const { page, app } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await app.evaluate(() => {
    ;(globalThis as unknown as { __e2e: { forceUnfocused: boolean } }).__e2e.forceUnfocused = true
  })
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })
  await expectWaiting(page, 1)
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (globalThis as unknown as { __e2e: { notifications: unknown[] } }).__e2e.notifications
            .length
      )
    )
    .toBe(1)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await app.evaluate(() => {
    ;(
      globalThis as unknown as { __e2e: { clickNotification(i: number): void } }
    ).__e2e.clickNotification(0)
  })
  const panel = request(page, 'question')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-highlight', /.*/)
  await expectNoDialog(page)
})

test('5.6: the status region announces a request that arrives after the session was opened', async () => {
  const { page } = await setup('dock-typed', 2)
  await expectWaiting(page, 1, { timeout: 30_000 })
  const status = page.locator('[data-attention-status]')
  await sendToBrain(page, 'GO-SECOND')
  await expectWaiting(page, 2, { timeout: 30_000 })
  await expect(status).toContainText('New request: Permission from W2')
})
