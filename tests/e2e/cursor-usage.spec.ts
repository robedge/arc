// @spec: 010-cursor-as-a-third-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCursorRig } from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, startSession, workerCard } from './sessions-rig'
import {
  allTokens,
  chipTotal,
  openUsagePage,
  openUsagePanel,
  pickRange,
  tokensOf,
  usagePanel
} from './usage-rig'

/**
 * Spec 010 section 2.5 (Slice 6): Cursor tokens and plan usage. The brain is the fake Claude CLI (deterministic usage)
 * and the worker is the fake Cursor in `acp` mode running the cr-worker script; FAKE_CURSOR_USAGE decides whether the
 * fake reports token counts (`prompt`: a usage object in each prompt response) or none (`none`, what the real Cursor
 * does). No model call is made.
 */

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const TITLE = 'W1 · review'

/** A session whose brain starts the Cursor worker "review", which writes a file, reports done and is merged. */
async function cursorSession(usageMode: 'none' | 'prompt'): Promise<CursorRig> {
  const r = await launchCursorRig({
    cursorScenario: 'cr-worker',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_USAGE: usageMode }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')
  const card = workerCard(page, TITLE)
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  return r
}

const panelRows = (panel: Locator): Locator => panel.locator('[data-usage-row]')
const brainRow = (panel: Locator): Locator => panelRows(panel).filter({ hasText: /brain/i })
const workerRow = (panel: Locator): Locator => panelRows(panel).filter({ hasText: 'review' })

async function closePanel(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(usagePanel(page)).toHaveCount(0)
}

test('2.5: when Cursor reports no tokens, its worker reads Not reported, is left out of the totals, and the plan meter reads Not reported', async () => {
  const r = await cursorSession('none')
  const { page } = r

  // The panel: the worker's row reads "Not reported", the brain's row has its tokens, and the line says why.
  const panel = await openUsagePanel(page)
  await expect(panelRows(panel)).toHaveCount(2)
  const worker = workerRow(panel)
  await expect(worker).toContainText('Cursor')
  await expect(worker).toContainText('Not reported')
  expect(await allTokens(worker.locator('td'))).toEqual([])
  await expect(panel.locator('[data-usage-not-reported]')).toHaveText(
    "Cursor doesn't report tokens; its agents aren't in these totals."
  )

  // The session total is the brain alone; there is no Cursor total.
  await expect
    .poll(async () => (await allTokens(brainRow(panel).locator('td')))[4] ?? 0)
    .toBeGreaterThan(0)
  const brainTotal = (await allTokens(brainRow(panel).locator('td')))[4]!
  expect((await allTokens(panel.locator('[data-usage-total] td')))[4]).toBe(brainTotal)
  await expect(panel.locator('[data-usage-provider-total="cursor"]')).toHaveCount(0)
  await expect(panel.locator('[data-usage-provider-total="claude"]')).toBeVisible()
  await closePanel(page)
  expect(await chipTotal(page)).toBe(brainTotal)

  // The worker card reads "Not reported" too.
  await expect(workerCard(page, TITLE)).toContainText('Not reported')

  // The plan meter reads "Cursor · Not reported".
  const meter = page.locator('[data-plan-meter="cursor"]')
  await expect(meter).toHaveAttribute('aria-label', 'Cursor · Not reported')
  await expect(meter).toHaveAttribute('data-plan-meter-state', 'not-reported')

  // The Usage page lists "Cursor · Not reported", the chart still draws with Claude's bars and no Cursor bar, and the
  // range total is Claude's.
  const view = await openUsagePage(page)
  await pickRange(page, 'today')
  const cursorTotal = view.locator('[data-total-provider="cursor"]')
  await expect(cursorTotal).toHaveText(/Cursor · Not reported/)
  await expect(cursorTotal.locator('[data-tokens]')).toHaveCount(0)
  await expect(view.locator('[data-daily-chart]')).toBeVisible()
  await expect(view.locator('[data-chart-legend]')).toContainText('Claude')
  await expect(view.locator('[data-chart-legend]')).not.toContainText('Cursor')
  await expect(
    view.locator('[data-daily-chart] [fill="var(--color-chart-claude)"]').first()
  ).toBeAttached()
  await expect(view.locator('[data-daily-chart] [fill="url(#chart-dots-cursor)"]')).toHaveCount(0)
  const claudeTotal = await tokensOf(
    view.locator('[data-total-provider="claude"] [data-token-count]')
  )
  expect(claudeTotal).toBeGreaterThanOrEqual(brainTotal)
  expect(await tokensOf(view.locator('[data-range-total] [data-token-count]'))).toBe(claudeTotal)
})

test('2.5: when Cursor reports tokens, its worker row has them, the Cursor total is listed, the chip includes them and the chart has a Cursor series', async () => {
  const r = await cursorSession('prompt')
  const { page } = r

  // The fake's single turn reports input 120, output 30, cache read 40, cache write 0.
  const panel = await openUsagePanel(page)
  await expect(panelRows(panel)).toHaveCount(2)
  const worker = workerRow(panel)
  await expect(worker).toContainText('Cursor')
  await expect.poll(async () => allTokens(worker.locator('td'))).toEqual([120, 0, 40, 30, 190])
  await expect(worker).not.toContainText('Not reported')
  await expect(panel.locator('[data-usage-not-reported]')).toHaveCount(0)

  // The Cursor total is listed, and the session total and the chip include it.
  const cursor = panel.locator('[data-usage-provider-total="cursor"]')
  await expect(cursor).toContainText('Cursor')
  expect(await tokensOf(cursor.locator('[data-token-count]'))).toBe(190)
  await expect
    .poll(async () => (await allTokens(brainRow(panel).locator('td')))[4] ?? 0)
    .toBeGreaterThan(0)
  const brainTotal = (await allTokens(brainRow(panel).locator('td')))[4]!
  expect((await allTokens(panel.locator('[data-usage-total] td')))[4]).toBe(brainTotal + 190)
  await closePanel(page)
  expect(await chipTotal(page)).toBe(brainTotal + 190)

  // The worker card shows its own tokens.
  expect(await tokensOf(workerCard(page, TITLE).locator('[data-token-count]'))).toBe(190)

  // Cursor reports no plan limits, so its meter still reads "Not reported".
  await expect(page.locator('[data-plan-meter="cursor"]')).toHaveAttribute(
    'aria-label',
    'Cursor · Not reported'
  )

  // The Usage page: a Cursor total, and the daily chart has a Cursor series (dotted bars and a legend entry).
  const view = await openUsagePage(page)
  await pickRange(page, 'today')
  const cursorTotal = view.locator('[data-total-provider="cursor"]')
  await expect(cursorTotal).toContainText('Cursor')
  expect(await tokensOf(cursorTotal.locator('[data-token-count]'))).toBe(190)
  await expect(view.locator('[data-daily-chart]')).toBeVisible()
  const legend = view.locator('[data-chart-legend]')
  await expect(legend).toContainText('Claude')
  await expect(legend.locator('li').filter({ hasText: 'Cursor' })).toHaveCount(1)
  await expect(
    legend.locator('li').filter({ hasText: 'Cursor' }).locator('[fill="url(#chart-dots-cursor)"]')
  ).toHaveCount(1)
  await expect(
    view.locator('[data-daily-chart] [fill="url(#chart-dots-cursor)"]').first()
  ).toBeAttached()
  // The chart's table carries the Cursor column with today's 190.
  const table = view.locator('[data-chart-table]')
  await expect(table.locator('thead')).toContainText('Cursor')
  await expect(table.locator('tbody tr').last()).toContainText('190')
})
