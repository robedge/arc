// @spec: 008-plan-usage-and-token-spend
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, startSession } from './sessions-rig'
import { openUsagePage, openUsagePanel } from './usage-rig'

/**
 * Spec 008 section 2.5: suggestions. Each scenario makes the fake CLIs do one wasteful thing (a strong model on a small
 * task, a heavy setup, the same file read again and again, a very long conversation); no model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const LONG = { timeout: 30_000 }

/** Starts a session on the scenario and opens its usage panel. */
async function sessionPanel(
  scenario: string,
  request: string
): Promise<{ r: CodexRig; panel: Locator }> {
  const r = await launchCodexRig({ scenario, repos: [{ name: 'api' }], codexInstalled: false })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request, mode: 'Autonomous' })
  return { r, panel: await openUsagePanel(r.page) }
}

test('2.5: a worker on Opus that read 2 files and changed none gets a "Model too strong" suggestion naming it and a lighter model', async () => {
  const { panel } = await sessionPanel('sg-deep', 'Look at the code')
  const s = panel.locator('[data-suggestion="model-too-strong"]')
  await expect(s).toHaveCount(1, LONG)
  await expect(s).toContainText('Model too strong')
  await expect(s).toContainText('W1 used Opus for a task that read 2 files and changed none.')
  await expect(s).toContainText('Sonnet would likely do.')
})

test('2.5: a fixed setup of 30,000 tokens or more per request shows one "Setup overhead" suggestion naming the agent and the advice for a CLI-heavy setup', async () => {
  const { panel } = await sessionPanel('sg-setup', 'Say hello')
  const s = panel.locator('[data-suggestion="setup-overhead"]')
  await expect(s).toHaveCount(1, LONG)
  await expect(s).toContainText('Setup overhead')
  await expect(s).toContainText(
    /Setup is about 33k tokens per request for the brain \(Arc's additions about \d+% of it\)\./
  )
  await expect(s).toContainText("Most of it is the CLI's own instructions plus your plugins")
  await expect(s).toContainText("Turning off the ones the agents don't need shrinks every request.")
})

test('2.5: the same file read 3 times by workers of a session shows a "Repeated work" suggestion naming the file and the workers', async () => {
  const { panel } = await sessionPanel('sg-repeat', 'Look at the schema')
  const s = panel.locator('[data-suggestion="repeated-work"]')
  await expect(s).toHaveCount(1, LONG)
  await expect(s).toContainText('Repeated work')
  await expect(s).toContainText('W1 and W2 both read api/db/schema.sql (3 reads in all).')
})

test('2.5: a brain turn with more than 200k input tokens shows a "Long-running agent" suggestion naming the brain and its size', async () => {
  const { panel } = await sessionPanel('sg-long', 'Keep going')
  const s = panel.locator('[data-suggestion="long-running"]')
  await expect(s).toHaveCount(1, LONG)
  await expect(s).toContainText('Long-running agent')
  await expect(s).toContainText("The brain's conversation is now 250k tokens")
  await expect(s).toContainText('Starting a new session for unrelated work would reduce it.')
})

const suggestionsOnPage = (page: Page): Locator =>
  page.locator('[data-usage-view] [data-suggestion]')

test('2.5: the Usage page lists undismissed suggestions newest first, each linking to its session, and a dismissed one is gone from both places for good', async () => {
  const first = await sessionPanel('sg-deep', 'Look at the code')
  await expect(first.panel.locator('[data-suggestion="model-too-strong"]')).toHaveCount(1, LONG)
  await first.r.page.keyboard.press('Escape')

  // A second session, a little later, on another scenario.
  await first.r.relaunch({ scenario: 'sg-repeat' })
  const page = first.r.page
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await startSession(page, { request: 'Look at the schema', mode: 'Autonomous' })
  await expect(
    (await openUsagePanel(page)).locator('[data-suggestion="repeated-work"]')
  ).toHaveCount(1, LONG)
  await page.keyboard.press('Escape')

  // The Usage page: newest first (the repeated reads came after the Opus worker), each with its session link.
  await openUsagePage(page)
  const items = suggestionsOnPage(page)
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toHaveAttribute('data-suggestion', 'repeated-work')
  await expect(items.nth(1)).toHaveAttribute('data-suggestion', 'model-too-strong')
  await expect(items.nth(0).locator('[data-suggestion-session]')).toHaveText('Repeated reads')
  await expect(items.nth(1).locator('[data-suggestion-session]')).toHaveText('Deep worker')

  // The link opens that session, where the same suggestion is in its panel.
  await items.nth(1).locator('[data-suggestion-session]').click()
  await expect(page.locator('[data-usage-view]')).toHaveCount(0)
  await expect(page.locator('[data-session-name]')).toHaveText('Deep worker')
  const panel = await openUsagePanel(page)
  await expect(panel.locator('[data-suggestion="model-too-strong"]')).toHaveCount(1)

  // Dismiss it here: it disappears from the panel...
  await panel.getByRole('button', { name: /^Dismiss suggestion: Model too strong/ }).click()
  await expect(panel.locator('[data-suggestion]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // ...and from the Usage page, where the other one stays.
  await openUsagePage(page)
  await expect(suggestionsOnPage(page)).toHaveCount(1)
  await expect(suggestionsOnPage(page).first()).toHaveAttribute('data-suggestion', 'repeated-work')

  // It does not come back when Arc is opened again.
  await first.r.relaunch()
  await openUsagePage(first.r.page)
  await expect(suggestionsOnPage(first.r.page)).toHaveCount(1)
  await expect(suggestionsOnPage(first.r.page).first()).toHaveAttribute(
    'data-suggestion',
    'repeated-work'
  )
  await first.r.page.locator('[data-usage-view]').getByRole('button', { name: 'Back' }).click()
  await first.r.page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await first.r.page.locator('[data-session-row]').filter({ hasText: 'Deep worker' }).click()
  await expect(first.r.page.locator('[data-session-name]')).toHaveText('Deep worker')
  await expect((await openUsagePanel(first.r.page)).locator('[data-suggestion]')).toHaveCount(0)
})
