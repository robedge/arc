// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function box(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await locator.boundingBox()
  if (!b) throw new Error('element has no box')
  return b
}

async function scrollState(locator: Locator): Promise<{ scrollTop: number; overflows: boolean }> {
  return locator.evaluate((el) => ({
    scrollTop: el.scrollTop,
    overflows: el.scrollHeight > el.clientHeight + 1
  }))
}

async function pageDoesNotScroll(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.scrollingElement
    return !el || el.scrollHeight <= window.innerHeight + 1
  })
}

test('2.3 + 2.4: layout fits 1100x720, panels scroll on their own, code block Copy', async () => {
  rig = await launchRig({ scenario: 'layout', repos: [{ name: 'api' }] })
  const { app, page, repos } = rig
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 720)
  )
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, {
    request: 'Why is the orders report slow?',
    mode: 'Autonomous',
    limit: 6
  })

  const conversation = page.getByRole('log', { name: 'Conversation' })
  const header = page.locator('[data-session-name]')
  const agents = page.locator('[data-agent-column]')
  const log = page.locator('[data-event-log]')
  await expect(page.locator('[data-worker-card]')).toHaveCount(6)

  // Header, conversation, agent cards and event log are all visible at once in 1100 x 720.
  expect(await page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1100, 720])
  for (const part of [header, conversation, agents, log]) await expect(part).toBeInViewport()
  expect(await pageDoesNotScroll(page)).toBe(true)

  // A conversation longer than the screen scrolls on its own: nothing else moves.
  await expect(conversation.getByText('Line 70 of the long explanation')).toBeVisible()
  const before = {
    header: await box(header),
    agents: await box(agents),
    log: await box(log),
    convo: await box(conversation)
  }
  const convoBefore = await scrollState(conversation)
  expect(convoBefore.overflows).toBe(true)
  await conversation.evaluate((el) => (el.scrollTop = 0))
  expect((await scrollState(conversation)).scrollTop).toBeLessThan(convoBefore.scrollTop)
  expect(await box(header)).toEqual(before.header)
  expect(await box(agents)).toEqual(before.agents)
  expect(await box(log)).toEqual(before.log)
  expect(await box(conversation)).toEqual(before.convo)
  expect(await pageDoesNotScroll(page)).toBe(true)

  // Six workers: only the agent cards move when they scroll.
  const agentsState = await scrollState(agents)
  expect(agentsState.overflows).toBe(true)
  const convoTop = (await scrollState(conversation)).scrollTop
  await agents.evaluate((el) => (el.scrollTop = el.scrollHeight))
  expect((await scrollState(agents)).scrollTop).toBeGreaterThan(agentsState.scrollTop)
  expect(await box(header)).toEqual(before.header)
  expect(await box(agents)).toEqual(before.agents)
  expect(await box(log)).toEqual(before.log)
  expect((await scrollState(conversation)).scrollTop).toBe(convoTop)
  expect(await pageDoesNotScroll(page)).toBe(true)

  // The code block is monospace and has a Copy button that answers "Copied".
  const code = conversation.locator('pre code').first()
  await code.scrollIntoViewIfNeeded()
  await expect(code).toContainText('CREATE INDEX idx_orders_created')
  expect(await code.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/mono/i)
  const copy = conversation.getByRole('button', { name: 'Copy' })
  await copy.click()
  await expect(conversation.getByRole('button', { name: 'Copied' })).toBeVisible()
})

test('2.3 + 2.4: Thinking and the ring, Reduce Motion, Stop, Shift+Enter, Enter', async () => {
  rig = await launchRig({ scenario: 'hang-reply.jsonl', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Look into the orders report' })

  const brain = page.locator('[data-brain-card]')
  const ring = brain.locator('svg.ring-logo')
  const conversation = page.getByRole('log', { name: 'Conversation' })
  const reply = conversation.locator('[data-message-role="brain"]')

  // The brain is replying: it says Thinking and the ring turns; with Reduce Motion the ring holds still.
  await expect(brain).toHaveAttribute('data-state', 'thinking')
  await expect(brain.getByRole('status')).toHaveText('Thinking')
  await expect(ring).toHaveAttribute('data-spin', 'true')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(ring).not.toHaveAttribute('data-spin', 'true')
  await expect(brain.getByRole('status')).toHaveText('Thinking')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect(ring).toHaveAttribute('data-spin', 'true')

  // The reply streams in word by word; Stop replaces Send.
  await expect(reply).toContainText('details...')
  const stop = page.getByRole('button', { name: 'Stop' })
  await expect(page.getByRole('button', { name: 'Send' })).toHaveCount(0)
  await stop.click()
  await expect(reply.locator('xpath=..').getByText('Stopped', { exact: true })).toBeVisible()
  await expect(reply).toHaveAttribute('data-message-state', 'stopped')
  const kept = await reply.innerText()
  expect(kept).toContain('details...')
  await expect(page.getByRole('button', { name: 'Send' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  await expect(brain).toHaveAttribute('data-state', 'idle')

  // Shift+Enter starts a new line and sends nothing.
  const input = page.getByPlaceholder('Message the brain')
  const userMessages = conversation.locator('[data-message-role="user"]')
  await expect(userMessages).toHaveCount(1)
  await input.click()
  await input.pressSequentially('first line')
  await input.press('Shift+Enter')
  await input.pressSequentially('second line')
  await expect(input).toHaveValue('first line\nsecond line')
  await expect(userMessages).toHaveCount(1)

  // Enter sends it: it appears in the conversation and the brain card changes to Thinking.
  await input.press('Enter')
  await expect(userMessages).toHaveCount(2)
  await expect(userMessages.last()).toHaveText('first line\nsecond line')
  await expect(input).toHaveValue('')
  await expect(brain).toHaveAttribute('data-state', 'thinking')
  await expect(brain.getByRole('status')).toHaveText('Thinking')
})

test('2.4: signed-out Claude Code shows the banner with Retry and keeps the message', async () => {
  rig = await launchRig({ scenario: 'hang-reply.jsonl', auth: 'out', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])

  const banner = page.getByText(
    "Claude Code isn't signed in. Open Terminal, run claude, and sign in, then click Retry."
  )
  await expect(banner.first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()

  await startSession(page, { request: 'Why is the orders report slow?' })
  // Nothing was sent: the dialog stays open with the request kept and says how to fix it.
  const dialog = page.getByRole('dialog', { name: 'New session' })
  await expect(
    dialog.getByText(
      "Claude Code isn't available, so the message wasn't sent. Fix it from the banner, then send it again."
    )
  ).toBeVisible()
  await expect(dialog.getByLabel('Request')).toHaveValue('Why is the orders report slow?')
  await expect(page.getByRole('button', { name: 'Retry' }).first()).toBeVisible()
})
