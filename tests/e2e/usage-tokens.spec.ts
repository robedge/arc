// @spec: 008-plan-usage-and-token-spend
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, startSession, workerCard } from './sessions-rig'
import {
  allTokens,
  chipTotal,
  closeUsagePage,
  openUsagePage,
  openUsagePanel,
  pickRange,
  query,
  reopenSession,
  sql,
  tokensOf,
  usageChip
} from './usage-rig'

/**
 * Spec 008 sections 2.1 and 2.2: tokens in a session and where they go. The brain and the Claude worker are the fake
 * Claude CLI (deterministic usage), the Codex worker is the fake Codex app-server; no model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const DONE = /done|merged/

/** A session with the brain, the Claude worker "alpha" and the Codex worker "beta", all finished. */
async function mixedSession(): Promise<CodexRig> {
  const r = await launchCodexRig({
    scenario: 'us-mixed',
    codexScenario: 'us-mixed',
    repos: [{ name: 'api' }]
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Look around', mode: 'Autonomous' })
  await expect(workerCard(r.page, 'alpha')).toHaveAttribute('data-worker-card', DONE, {
    timeout: 30_000
  })
  await expect(workerCard(r.page, 'beta')).toHaveAttribute('data-worker-card', DONE, {
    timeout: 30_000
  })
  return r
}

/** The five figures of a panel row, in column order: input, cache write, cache read, output, total. */
async function figures(row: Locator): Promise<number[]> {
  return allTokens(row.locator('td'))
}

/** Waits until all three agents have their tokens and the chip and the panel agree, so later reads see settled totals. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(async () => {
      const total = await chipTotal(page)
      const panel = await openUsagePanel(page)
      const rows = panel.locator('[data-usage-row]')
      if ((await rows.count()) !== 3) return false
      for (let i = 0; i < 3; i += 1) if (((await figures(rows.nth(i)))[4] ?? 0) === 0) return false
      return (await figures(panel.locator('[data-usage-total]')))[4] === total
    })
    .toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-usage-panel]')).toHaveCount(0)
}

test('2.1: the chip is the sum of the brain and both workers, each card shows its own total, and the panel breaks it down by agent and provider', async () => {
  const r = await mixedSession()
  const { page } = r
  await settled(page)

  // The panel lists the brain and each worker with provider, model and the four columns plus the total.
  const panel = await openUsagePanel(page)
  const rows = panel.locator('[data-usage-row]')
  await expect(rows).toHaveCount(3)
  await expect(panel.locator('thead')).toContainText('Input')
  await expect(panel.locator('thead')).toContainText('Cache write (cold)')
  await expect(panel.locator('thead')).toContainText('Cache read (hit)')
  await expect(panel.locator('thead')).toContainText('Output')
  await expect(panel.locator('thead')).toContainText('Total')
  const brain = rows.filter({ hasText: /brain/i })
  const alpha = rows.filter({ hasText: 'alpha' })
  const beta = rows.filter({ hasText: 'beta' })
  await expect(brain).toHaveCount(1)
  await expect(alpha).toContainText('Claude')
  await expect(alpha).toContainText('Sonnet')
  await expect(beta).toContainText('Codex')
  const [brainFigures, alphaFigures, betaFigures] = [
    await figures(brain),
    await figures(alpha),
    await figures(beta)
  ]
  for (const f of [brainFigures, alphaFigures, betaFigures]) {
    expect(f).toHaveLength(5)
    // The total is the four columns added up, and every agent used something.
    expect(f[0]! + f[1]! + f[2]! + f[3]!).toBe(f[4])
    expect(f[4]).toBeGreaterThan(0)
  }

  // The header chip is the sum of the brain and both workers, and so is the session total row.
  const sum = brainFigures[4]! + alphaFigures[4]! + betaFigures[4]!
  expect(await chipTotal(page)).toBe(sum)
  expect((await figures(panel.locator('[data-usage-total]')))[4]).toBe(sum)

  // Each worker card shows that worker's own total.
  expect(await tokensOf(workerCard(page, 'alpha').locator('[data-token-count]'))).toBe(
    alphaFigures[4]
  )
  expect(await tokensOf(workerCard(page, 'beta').locator('[data-token-count]'))).toBe(
    betaFigures[4]
  )
  await expect(workerCard(page, 'alpha').locator('[data-token-count]')).toContainText('tokens')

  // A separate total for Claude and for Codex.
  const claude = panel.locator('[data-usage-provider-total="claude"]')
  const codex = panel.locator('[data-usage-provider-total="codex"]')
  await expect(claude).toContainText('Claude')
  await expect(codex).toContainText('Codex')
  expect(await tokensOf(claude.locator('[data-token-count]'))).toBe(
    brainFigures[4]! + alphaFigures[4]!
  )
  expect(await tokensOf(codex.locator('[data-token-count]'))).toBe(betaFigures[4])

  // The summary line: new is input + cache write + output, from cache is cache read with its share of the total.
  const [bI, bW, bR, bO] = brainFigures as [number, number, number, number]
  const [aI, aW, aR, aO] = alphaFigures as [number, number, number, number]
  const [cI, cW, cR, cO] = betaFigures as [number, number, number, number]
  const fresh = bI + bW + bO + aI + aW + aO + cI + cW + cO
  const cached = bR + aR + cR
  const summary = panel.locator('[data-usage-summary]')
  expect(await allTokens(summary)).toEqual([fresh, cached])
  await expect(summary).toContainText(`(${Math.round((cached / sum) * 100)}%)`)

  // The weighted figure: Claude (the brain and alpha) and Codex (beta) each at their own ratios, then added.
  const claudeWeighted = bI + aI + 1.25 * (bW + aW) + 0.1 * (bR + aR) + 5 * (bO + aO)
  const codexWeighted = cI + cW + 0.1 * cR + 8 * cO
  const weighted = panel.locator('[data-usage-weighted]')
  await expect(weighted).toContainText('Weighted ≈')
  expect(await allTokens(weighted)).toEqual([Math.round(claudeWeighted + codexWeighted)])
  await expect(weighted).toHaveAttribute(
    'title',
    "Weighted by cost relative to normal input: Claude cache read x0.1, cache write x1.25, output x5; Codex cached input x0.1, output x8; Cursor, where it reports tokens, at Claude's ratios. Not a dollar amount."
  )
  // The header chip stays raw.
  await expect(usageChip(page)).not.toContainText('Weighted')

  // The footnote about what Arc cannot see is always there.
  await expect(panel.locator('[data-usage-not-counted]')).toHaveText(
    'Not counted: CLI runs an agent starts itself, for example claude -p from its shell.'
  )
})

test('2.1: a short number shows the exact count on hover', async () => {
  const r = await mixedSession()
  const { page } = r
  await settled(page)

  const count = usageChip(page).locator('[data-token-count]')
  const exact = await tokensOf(count)
  // The three agents together are more than a thousand tokens, so the chip shows the short form ("2.9k").
  expect(exact).toBeGreaterThanOrEqual(1000)
  await expect(count).toHaveText(/^\d+(\.\d)?k$/)
  await count.hover()
  await expect(count).toHaveAttribute('title', `${exact.toLocaleString('en-US')} tokens`)
  await expect(count).toHaveAttribute('aria-label', `${exact.toLocaleString('en-US')} tokens`)
})

/** Reads the figure of a count until `stop` says so, returning every distinct value seen, in order. */
async function risesUntil(
  read: () => Promise<number>,
  stop: (n: number) => boolean
): Promise<number[]> {
  const seen: number[] = []
  const deadline = Date.now() + 25_000
  while (Date.now() < deadline) {
    const n = await read()
    if (seen[seen.length - 1] !== n) seen.push(n)
    if (stop(n)) return seen
    await new Promise((done) => setTimeout(done, 150))
  }
  return seen
}

const savedSum = (r: CodexRig, where = '1=1'): number =>
  Number(
    query(
      r,
      `SELECT COALESCE(SUM(input_tokens + cache_write_tokens + cache_read_tokens + output_tokens), 0) AS n
       FROM usage_turns WHERE ${where}`
    )[0]?.['n']
  )

test('2.1: during one long turn the cards and the chip rise request by request, marked in progress, and end equal to the saved rows', async () => {
  const r = await launchCodexRig({
    scenario: 'us-live-workers',
    codexScenario: 'us-live-workers',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Look around', mode: 'Autonomous' })

  const alpha = workerCard(page, 'alpha')
  const beta = workerCard(page, 'beta')
  const betaCount = beta.locator('[data-token-count]')
  const alphaCount = alpha.locator('[data-token-count]')
  await expect(beta).toHaveAttribute('data-worker-card', 'working', { timeout: 30_000 })
  await expect(alpha).toHaveAttribute('data-worker-card', 'working', { timeout: 30_000 })

  // The Codex worker's first request is on the card while its turn is still running, with the in-progress marker.
  await expect.poll(() => tokensOf(betaCount), { timeout: 10_000 }).toBeGreaterThan(0)
  await expect(beta.locator('[data-in-progress]')).toBeVisible()
  await expect(beta).toHaveAttribute('data-worker-card', 'working')

  // The card follows each further request (150 tokens each, 3 s apart) without waiting for the turn to end.
  const steps = await risesUntil(
    () => tokensOf(betaCount),
    (n) => n >= 450
  )
  expect(steps.length).toBeGreaterThanOrEqual(3)
  expect(steps.slice(-3)).toEqual([150, 300, 450])
  await expect(beta).toHaveAttribute('data-worker-card', 'working')
  // The Claude worker's card rises the same way.
  await expect.poll(() => tokensOf(alphaCount), { timeout: 5000 }).toBeGreaterThan(1000)
  await expect(alpha.locator('[data-in-progress]')).toBeVisible()
  await expect(alpha).toHaveAttribute('data-worker-card', 'working')

  // Header chip and panel: the chip marks it, the totals include the cards, and only the running agents are marked.
  await expect(usageChip(page).locator('[data-in-progress]')).toBeVisible()
  const panel = await openUsagePanel(page)
  const brainRow = panel.locator('[data-usage-row="brain"]')
  await expect(
    panel.locator('[data-usage-row]').filter({ hasText: 'beta' }).locator('[data-in-progress]')
  ).toBeVisible()
  await expect(
    panel.locator('[data-usage-row]').filter({ hasText: 'alpha' }).locator('[data-in-progress]')
  ).toBeVisible()
  await expect(brainRow.locator('[data-in-progress]')).toHaveCount(0)
  await expect(panel.locator('[data-usage-total] [data-in-progress]')).toBeVisible()
  await expect
    .poll(async () => {
      const brain = (await figures(brainRow))[4]!
      return (
        (await chipTotal(page)) -
        (brain + (await tokensOf(alphaCount)) + (await tokensOf(betaCount)))
      )
    })
    .toBe(0)
  expect((await figures(panel.locator('[data-usage-total]')))[4]).toBe(await chipTotal(page))
  await page.keyboard.press('Escape')

  // Nothing is saved for the workers yet, and the Usage page counts saved rows only.
  const savedMidTurn = savedSum(r)
  expect(savedSum(r, "agent_key <> 'brain'")).toBe(0)
  const view = await openUsagePage(page)
  await pickRange(page, 'today')
  await expect
    .poll(() => tokensOf(view.locator('[data-range-total] [data-tokens]')))
    .toBe(savedMidTurn)
  await closeUsagePage(page)
  await expect(beta).toHaveAttribute('data-worker-card', 'working')

  // The turns end: the markers go and every figure equals the saved rows, once.
  await expect(alpha).toHaveAttribute('data-worker-card', DONE, { timeout: 30_000 })
  await expect(beta).toHaveAttribute('data-worker-card', DONE, { timeout: 30_000 })
  await expect(page.locator('[data-in-progress]')).toHaveCount(0)
  const workers = query(r, 'SELECT id, slug FROM workers')
  const keyOf = (slug: string): string => workers.find((w) => w['slug'] === slug)!['id'] as string
  const savedBeta = savedSum(r, `agent_key = '${keyOf('beta')}'`)
  const savedAlpha = savedSum(r, `agent_key = '${keyOf('alpha')}'`)
  expect(savedBeta).toBe(600)
  expect(savedAlpha).toBeGreaterThan(2000)
  await expect.poll(() => tokensOf(betaCount)).toBe(savedBeta)
  await expect.poll(() => tokensOf(alphaCount)).toBe(savedAlpha)
  await expect.poll(() => chipTotal(page)).toBe(savedSum(r))
  expect(query(r, 'SELECT COUNT(*) AS n FROM usage_turns')[0]?.['n']).toBe(3)
})

test("2.1: the brain's own long turn raises the chip request by request, then settles on the saved row", async () => {
  const r = await launchCodexRig({ scenario: 'us-live', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Look around', mode: 'Autonomous' })

  const count = usageChip(page).locator('[data-token-count]')
  await expect.poll(() => chipTotal(page), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(usageChip(page).locator('[data-in-progress]')).toBeVisible()
  const steps = await risesUntil(
    () => tokensOf(count),
    (n) => n >= 663 + 763 + 863
  )
  // Requests of 663, 763 and 863 tokens: the chip passes through each running total.
  expect(steps.slice(-3)).toEqual([663, 663 + 763, 663 + 763 + 863])
  expect(query(r, 'SELECT COUNT(*) AS n FROM usage_turns')[0]?.['n']).toBe(0)

  // The turn ends: the mark goes and the chip is the saved row, not more.
  await expect(usageChip(page).locator('[data-in-progress]')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => chipTotal(page)).toBe(savedSum(r))
  expect(query(r, 'SELECT COUNT(*) AS n FROM usage_turns')[0]?.['n']).toBe(1)
  const panel = await openUsagePanel(page)
  await expect(panel.locator('[data-in-progress]')).toHaveCount(0)
  expect((await figures(panel.locator('[data-usage-total]')))[4]).toBe(savedSum(r))
})

test('2.2: worker details show Arc\'s additions ("about"), the total fixed setup and the work, adding up to the input; the panel shows the session setup share', async () => {
  const r = await mixedSession()
  const { page } = r
  await settled(page)

  // The Claude worker's details.
  await workerCard(page, 'alpha')
    .getByRole('button', { name: /^Details for/ })
    .click()
  const details = page.locator('[data-worker-details]')
  await expect(details).toBeVisible()
  const split = details.locator('[data-setup-split]')
  const arc = split.locator('[data-setup-arc]')
  await expect(split).toContainText("Arc's additions")
  await expect(split).toContainText('Total fixed setup')
  await expect(split).toContainText('The work')
  await expect(arc).toContainText('about')
  await expect(arc).not.toContainText('Not measured yet')
  await expect(split.locator('[data-setup-fixed]')).not.toContainText('Not measured yet')
  const fixed = await allTokens(split.locator('[data-setup-fixed]'))
  expect(fixed).toHaveLength(2) // per request, in all
  const work = (await allTokens(split.locator('[data-setup-work]')))[0]!
  const input = (await allTokens(split.locator('[data-setup-input]')))[0]!
  // Fixed setup (in all) plus the work add up to the input total.
  expect(fixed[1]! + work).toBe(input)
  expect(fixed[1]).toBeGreaterThan(0)
  // The details also carry the same four-column breakdown as the panel.
  for (const key of ['input', 'cacheWrite', 'cacheRead', 'output', 'total']) {
    await expect(details.locator(`[data-worker-tokens-row="${key}"]`)).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(details).toHaveCount(0)

  // The session's usage panel shows the setup share and Arc's part of it.
  const panel = await openUsagePanel(page)
  await expect(panel.locator('[data-setup-share]')).toHaveText(
    /^Setup: \d+% of this session \(Arc's additions about \d+% of it\)$/
  )
})

test('2.1: a session from before this feature shows Not recorded for each agent that ran before', async () => {
  const r = await mixedSession()
  const { page } = r
  await settled(page)
  const session = query(r, 'SELECT id FROM sessions')[0]?.['id'] as string

  // Make the session look like one from before usage was recorded: no usage rows, and recording began after it.
  sql(r, [
    { sql: 'DELETE FROM usage_turns WHERE session_id = ?', params: [session] },
    {
      sql: "UPDATE app_settings SET value_json = ? WHERE key = 'usage.trackingStartedAt'",
      params: [String(Date.now() + 3_600_000)]
    }
  ])
  await r.relaunch()
  await reopenSession(r.page, 'Storefront', 'Mixed providers')

  const panel = await openUsagePanel(r.page)
  const rows = panel.locator('[data-usage-row]')
  await expect(rows).toHaveCount(3)
  for (let i = 0; i < 3; i += 1) await expect(rows.nth(i)).toContainText('Not recorded')
  await expect(rows.locator('[data-tokens]')).toHaveCount(0)
  // The worker cards say it too.
  await expect(workerCard(r.page, 'alpha').locator('[data-token-count]')).toHaveText('Not recorded')
})
