// @spec: 008-plan-usage-and-token-spend
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects } from './sessions-rig'
import type { SeedSession } from './usage-rig'
import {
  allTokens,
  localDay,
  openUsagePage,
  pickRange,
  resizeWindow,
  seedHistory,
  tokensOf
} from './usage-rig'

/**
 * Spec 008 section 2.3: the Usage page. A week of usage is written into Arc's database (a Claude-heavy session two days
 * ago and yesterday, a Codex session today, a small one three days ago, and a very old one outside the 30 days), then
 * the page is read through the built app. No model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const SONNET = 'claude-sonnet-5-5'
const OPUS = 'claude-opus-5-5'

function history(options: { today: boolean }): SeedSession[] {
  const sessions: SeedSession[] = [
    {
      id: 'seed-checkout',
      name: 'Checkout refactor',
      daysAgo: 2,
      turns: [
        {
          agent: 'brain',
          role: 'brain',
          provider: 'claude',
          model: SONNET,
          daysAgo: 1,
          total: 480_000
        },
        {
          agent: 'w-spec-1',
          role: 'worker',
          provider: 'claude',
          model: SONNET,
          daysAgo: 1,
          total: 120_000,
          command: '/awos:spec',
          workerLabel: 'W1'
        },
        {
          agent: 'brain',
          role: 'brain',
          provider: 'claude',
          model: OPUS,
          daysAgo: 2,
          total: 300_000
        }
      ]
    },
    {
      id: 'seed-docs',
      name: 'Docs cleanup',
      daysAgo: 3,
      turns: [
        {
          agent: 'brain',
          role: 'brain',
          provider: 'claude',
          model: SONNET,
          daysAgo: 3,
          total: 10_000
        },
        {
          agent: 'w-spec-2',
          role: 'worker',
          provider: 'claude',
          model: SONNET,
          daysAgo: 3,
          total: 40_000,
          command: '/awos:spec',
          workerLabel: 'W1'
        }
      ]
    },
    {
      id: 'seed-old',
      name: 'Old migration',
      daysAgo: 40,
      turns: [
        {
          agent: 'brain',
          role: 'brain',
          provider: 'claude',
          model: SONNET,
          daysAgo: 40,
          total: 1_000_000
        }
      ]
    }
  ]
  if (options.today) {
    sessions.push({
      id: 'seed-search',
      name: 'Search tuning',
      daysAgo: 0,
      turns: [
        {
          agent: 'brain',
          role: 'brain',
          provider: 'codex',
          model: 'gpt-5.4',
          daysAgo: 0,
          total: 170_000
        },
        {
          agent: 'w-tasks-1',
          role: 'worker',
          provider: 'codex',
          model: 'gpt-5.4',
          daysAgo: 0,
          total: 30_000,
          command: '/awos:tasks',
          workerLabel: 'W1'
        }
      ]
    })
  }
  return sessions
}

async function withHistory(options: {
  today: boolean
}): Promise<{ r: CodexRig; view: Locator; page: Page }> {
  const r = await launchCodexRig({
    scenario: 'text-reply.jsonl',
    repos: [{ name: 'api' }],
    codexInstalled: false
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  seedHistory(r, history(options))
  await r.relaunch()
  const view = await openUsagePage(r.page)
  return { r, view, page: r.page }
}

const total = (view: Locator): Promise<number> =>
  tokensOf(view.locator('[data-range-total] [data-tokens]'))
const byProvider = (view: Locator, p: string): Promise<number> =>
  tokensOf(view.locator(`[data-total-provider="${p}"] [data-tokens]`))
const byModel = (view: Locator, key: string): Promise<number> =>
  tokensOf(view.locator(`[data-total-model="${key}"] [data-tokens]`))

test('2.3: the page opens on the last 7 days with the total, a total per provider and per model, and a day-by-day chart', async () => {
  const { view, page } = await withHistory({ today: true })
  await expect(page.locator('[data-range="7d"]')).toHaveAttribute('aria-checked', 'true')

  // 900k + 200k + 50k in the week; the 1M session 40 days ago is outside it.
  await expect.poll(() => total(view)).toBe(1_150_000)
  expect(await byProvider(view, 'claude')).toBe(950_000)
  expect(await byProvider(view, 'codex')).toBe(200_000)
  expect(await byModel(view, `claude:${SONNET}`)).toBe(650_000)
  expect(await byModel(view, `claude:${OPUS}`)).toBe(300_000)
  expect(await byModel(view, 'codex:gpt-5.4')).toBe(200_000)

  // The seeded turns are 10% input, 10% cache write, 70% cache read, 10% output: 30% is new, 70% from cache.
  const summary = view.locator('[data-usage-totals] [data-usage-summary]')
  await expect(summary).toContainText('New')
  await expect(summary).toContainText('From cache')
  await expect(summary).toContainText('(70%)')
  expect(await allTokens(summary)).toEqual([345_000, 805_000])
  // Weighted per provider: Claude 950k -> 95k + 95k x1.25 + 665k x0.1 + 95k x5 = 755,250; Codex 200k -> 20k + 20k + 14k + 20k x8 = 214,000.
  const weighted = view.locator('[data-usage-totals] [data-usage-weighted]')
  await expect(weighted).toContainText('Weighted ≈')
  await expect(weighted).toHaveAttribute('title', /Not a dollar amount\.$/)
  expect(await allTokens(weighted)).toEqual([969_250])

  // One bar group for each of the 7 days, each day's usage split by provider.
  const days = view.locator('[data-daily-chart] [data-day]')
  await expect(days).toHaveCount(7)
  await expect(days.first()).toHaveAttribute('data-day', localDay(6))
  await expect(days.last()).toHaveAttribute('data-day', localDay(0))
  await expect(view.locator(`[data-day="${localDay(0)}"] [data-segment="codex"]`)).toHaveCount(1)
  await expect(view.locator(`[data-day="${localDay(0)}"] [data-segment="claude"]`)).toHaveCount(0)
  await expect(view.locator(`[data-day="${localDay(1)}"] [data-segment="claude"]`)).toHaveCount(1)
  await expect(view.locator(`[data-day="${localDay(5)}"] [data-segment]`)).toHaveCount(0)
  // Usage is counted on the day the tokens were used: the table has the exact figure of each day.
  await expect(view.locator(`[data-chart-row="${localDay(1)}"]`)).toContainText('600,000')
  await expect(view.locator(`[data-chart-row="${localDay(2)}"]`)).toContainText('300,000')
  await expect(view.locator(`[data-chart-row="${localDay(0)}"]`)).toContainText('200,000')
})

test('2.3: picking Today leaves only today in the totals, the chart and the rankings', async () => {
  const { view, page } = await withHistory({ today: true })
  await expect.poll(() => total(view)).toBe(1_150_000)
  await pickRange(page, 'today')

  await expect.poll(() => total(view)).toBe(200_000)
  await expect(view.locator('[data-total-provider]')).toHaveCount(1)
  expect(await byProvider(view, 'codex')).toBe(200_000)
  await expect(view.locator('[data-total-model]')).toHaveCount(1)
  await expect(view.locator('[data-daily-chart] [data-day]')).toHaveCount(1)
  await expect(view.locator('[data-daily-chart] [data-day]')).toHaveAttribute(
    'data-day',
    localDay(0)
  )
  const rows = view.locator('[data-spender-row]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Search tuning')
  await page.locator('[data-spender-kind="command"]').click()
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('/awos:tasks')
})

test('2.3: Biggest spenders lists sessions from most to fewest tokens with group, provider, model and total, and switches to commands', async () => {
  const { view, page } = await withHistory({ today: true })
  await expect.poll(() => total(view)).toBe(1_150_000)

  const rows = view.locator('[data-spender-row]')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('Checkout refactor')
  await expect(rows.nth(1)).toContainText('Search tuning')
  await expect(rows.nth(2)).toContainText('Docs cleanup')
  const totals = [
    await tokensOf(rows.nth(0).locator('[data-tokens]')),
    await tokensOf(rows.nth(1).locator('[data-tokens]')),
    await tokensOf(rows.nth(2).locator('[data-tokens]'))
  ]
  expect(totals).toEqual([900_000, 200_000, 50_000])
  for (let i = 0; i < 3; i += 1) await expect(rows.nth(i)).toContainText('Storefront')
  // A session on one model shows it; one that used two shows "Mixed".
  await expect(rows.nth(0)).toContainText('Claude · Mixed')
  await expect(rows.nth(1)).toContainText('Codex · gpt-5.4')
  await expect(rows.nth(2)).toContainText('Claude')
  await expect(rows.nth(2)).toContainText(SONNET)

  // Commands: each slash command used in the range, with the tokens of the workers that ran it.
  await page.locator('[data-spender-kind="command"]').click()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('/awos:spec')
  expect(await tokensOf(rows.nth(0).locator('[data-tokens]'))).toBe(160_000)
  await expect(rows.nth(0)).toContainText('2 runs')
  await expect(rows.nth(1)).toContainText('/awos:tasks')
  expect(await tokensOf(rows.nth(1).locator('[data-tokens]'))).toBe(30_000)
})

test('2.3: clicking a session in Biggest spenders opens that session', async () => {
  const { view, page } = await withHistory({ today: true })
  const rows = view.locator('[data-spender-row]')
  await expect(rows.first()).toContainText('Checkout refactor')
  await rows.filter({ hasText: 'Search tuning' }).getByRole('button').click()

  await expect(page.locator('[data-usage-view]')).toHaveCount(0)
  await expect(page.locator('[data-session-name]')).toHaveText('Search tuning')
  await expect(page.locator('[data-usage-chip]')).toContainText('200k')
})

test('2.3: with no usage today, picking Today says "No usage in this period."', async () => {
  const { view, page } = await withHistory({ today: false })
  await expect.poll(() => total(view)).toBe(950_000)

  await pickRange(page, 'today')
  await expect(view.getByText('No usage in this period.')).toBeVisible()
  await expect(view.locator('[data-range-total]')).toHaveCount(0)
  await expect(view.locator('[data-spender-row]')).toHaveCount(0)

  // All time still has everything, including the old session.
  await pickRange(page, 'all')
  await expect.poll(() => total(view)).toBe(1_950_000)
})

test('bug fix: the Usage chart keeps a fixed compact height (176px) whatever the window width', async () => {
  const { r, view } = await withHistory({ today: true })
  const chart = view.locator('[data-daily-chart]')
  await expect(chart).toBeVisible()

  const measure = async (): Promise<{ width: number; height: number }> => {
    const box = await chart.boundingBox()
    return { width: Math.round(box!.width), height: Math.round(box!.height) }
  }
  await resizeWindow(r, 1500, 900)
  await expect.poll(async () => (await measure()).width).toBeGreaterThan(900)
  const wide = await measure()
  await resizeWindow(r, 800, 900)
  await expect.poll(async () => (await measure()).width).toBeLessThan(wide.width - 300)
  const narrow = await measure()

  expect(wide.height).toBe(176)
  expect(narrow.height).toBe(176)
})
