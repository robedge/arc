// @spec: 008-plan-usage-and-token-spend
// @regression
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { closeSettings, launchCodexRig, openSettings } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { readFakeLog } from './sessions-rig'
import {
  FAKE_CLAUDE_PATH,
  asOfMinutes,
  inMinutes,
  nowMinutes,
  openUsagePage,
  resetText,
  tokensOf
} from './usage-rig'

/**
 * Spec 008 section 2.4 (meters part): the plan meters in the title bar, the launch plan check and the Usage page's
 * plan limits. The Claude limits come from the fake CLI's `rate_limit_event` (here through the launch plan check, which
 * HARNESS_PLAN_PROBE_BIN points at the fake); the Codex limits come from the fake app-server's
 * `account/rateLimits/read`. No model call is made.
 */

let rig: CodexRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const meter = (page: Page, provider: 'claude' | 'codex'): Locator =>
  page.locator(`[data-plan-meter="${provider}"]`)

/** The arguments of every plan check the fake Claude saw (`--system-prompt .` with no tools). */
function planChecks(r: CodexRig): unknown[] {
  return readFakeLog(r).filter((l) => {
    const argv = l['argv'] as string[] | undefined
    return argv?.includes('--system-prompt') && argv[argv.indexOf('--system-prompt') + 1] === '.'
  })
}

test('2.4: the Claude meter shows the 5-hour and weekly percentages, and hovering it shows each limit with its reset time', async () => {
  const fiveHourReset = inMinutes(90)
  const weeklyReset = inMinutes(3 * 24 * 60)
  const r = await launchCodexRig({
    scenario: 'text-reply.jsonl',
    repos: [{ name: 'api' }],
    env: {
      HARNESS_PLAN_PROBE_BIN: FAKE_CLAUDE_PATH,
      FAKE_CLAUDE_RATE_LIMIT: JSON.stringify({
        five_hour: { utilization: 0.42, resetsAt: fiveHourReset },
        seven_day: { utilization: 0.18, resetsAt: weeklyReset }
      })
    }
  })
  rig = r
  const { page } = r

  const claude = meter(page, 'claude')
  await expect(claude).toHaveAttribute('aria-label', 'Claude · 5h 42% · Weekly 18%')
  await expect(claude).toHaveAttribute('data-severity', 'ok')
  // Codex answers its limits as soon as Arc opens, with no agent running.
  await expect(meter(page, 'codex')).toHaveAttribute('aria-label', 'Codex · 5h 12% · Weekly 30%')

  // Hovering shows each limit's percentage and when it resets.
  await claude.hover()
  const popover = page.locator('[data-plan-popover]')
  await expect(popover).toBeVisible()
  const fiveHour = popover.locator('[data-plan-limit="claude:five_hour"]')
  const weekly = popover.locator('[data-plan-limit="claude:seven_day"]')
  await expect(fiveHour).toContainText('5h')
  await expect(fiveHour).toContainText('42%')
  await expect(fiveHour).toContainText(`Resets at ${resetText(fiveHourReset)}`)
  await expect(weekly).toContainText('Weekly')
  await expect(weekly).toContainText('18%')
  await expect(weekly).toContainText(`Resets at ${resetText(weeklyReset)}`)

  // The same limits sit on the Usage page.
  await page.mouse.move(0, 400)
  const view = await openUsagePage(page)
  const claudeLimits = view.locator('[data-plan-provider="claude"]')
  await expect(claudeLimits.locator('[data-plan-limit="claude:five_hour"]')).toContainText('42%')
  await expect(claudeLimits.locator('[data-plan-limit="claude:seven_day"]')).toContainText('18%')
})

test('2.4: on launch Arc checks the Claude plan once, the meter shows when it was updated, and the Usage page lists the Plan check', async () => {
  const r = await launchCodexRig({
    scenario: 'text-reply.jsonl',
    repos: [{ name: 'api' }],
    env: { HARNESS_PLAN_PROBE_BIN: FAKE_CLAUDE_PATH }
  })
  rig = r
  const { page } = r

  // The fake answers with five_hour 5% and seven_day 28%, like the recorded plan check.
  await expect(meter(page, 'claude')).toHaveAttribute('aria-label', 'Claude · 5h 5% · Weekly 28%')
  expect(planChecks(r)).toHaveLength(1)
  // The check runs on the lightest Claude model with no tools.
  const argv = (planChecks(r)[0] as { argv: string[] }).argv
  expect(argv[argv.indexOf('--model') + 1]).toMatch(/haiku/i)
  expect(argv[argv.indexOf('--tools') + 1]).toBe('')

  // "as of" is the time of this launch.
  await meter(page, 'claude').click()
  const asOf = await page.locator('[data-plan-limit="claude:five_hour"]').innerText()
  const minutes = asOfMinutes(asOf)
  expect(minutes).not.toBeNull()
  expect(Math.abs(nowMinutes() - minutes!)).toBeLessThanOrEqual(3)
  await page.keyboard.press('Escape')

  // It used a tiny amount of the plan and shows in Arc's usage as "Plan check".
  const view = await openUsagePage(page)
  const planCheck = view.locator('[data-plan-check]')
  await expect(planCheck).toContainText('Plan check')
  const tokens = await tokensOf(planCheck.locator('[data-token-count]'))
  expect(tokens).toBeGreaterThan(0)
  expect(tokens).toBeLessThan(2000)
})

test('2.4: a provider that reports no limit shows Not reported', async () => {
  const r = await launchCodexRig({
    scenario: 'text-reply.jsonl',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_RATE_LIMITS: 'none' }
  })
  rig = r
  const { page } = r
  const codex = meter(page, 'codex')
  await expect(codex).toHaveAttribute('aria-label', 'Codex · Not reported')
  await expect(codex).toHaveAttribute('data-plan-meter-state', 'not-reported')
  await codex.click()
  await expect(page.locator('[data-plan-popover]')).toContainText('Not reported')
})

test('2.4: with "Check Claude plan usage when Arc opens" off and no Claude agent run yet, the Claude meter says Waiting for first use', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'arc-s8-'))
  // The plan check program: it fails until the flag file exists, so the first launch (check on) learns nothing, and
  // the second launch (check off) would learn something only if Arc ran it in spite of the setting.
  const flag = join(scratch, 'run-plan-check')
  const wrapper = join(scratch, 'plan-check.sh')
  writeFileSync(wrapper, `#!/bin/sh\n[ -f '${flag}' ] || exit 1\nexec '${FAKE_CLAUDE_PATH}' "$@"\n`)
  chmodSync(wrapper, 0o755)

  const r = await launchCodexRig({
    scenario: 'text-reply.jsonl',
    repos: [{ name: 'api' }],
    env: { HARNESS_PLAN_PROBE_BIN: wrapper }
  })
  rig = r
  const { page } = r
  await expect(meter(page, 'claude')).toHaveAttribute(
    'aria-label',
    'Claude · Waiting for first use'
  )

  // Turn the check off in Settings, allow the program to answer, and open Arc again.
  await openSettings(page)
  const toggle = page.getByLabel('Check Claude plan usage when Arc opens')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  await closeSettings(page)
  writeFileSync(flag, '')
  await r.relaunch()

  await expect(meter(r.page, 'claude')).toHaveAttribute(
    'aria-label',
    'Claude · Waiting for first use'
  )
  await expect(meter(r.page, 'claude')).toHaveAttribute('data-plan-meter-state', 'waiting')
  // Give a launch check time to have shown up, then confirm none ran.
  await r.page.waitForTimeout(2500)
  await expect(meter(r.page, 'claude')).toHaveAttribute('data-plan-meter-state', 'waiting')
  expect(planChecks(r)).toHaveLength(0)
})

test('bug fix: only each meter is no-drag, so the empty title bar can still move the window', async () => {
  const r = await launchCodexRig({ scenario: 'text-reply.jsonl', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await expect(meter(page, 'codex')).toBeVisible()

  const regions = await page.evaluate(() => {
    const region = (selector: string): string =>
      getComputedStyle(document.querySelector(selector)!).getPropertyValue('-webkit-app-region')
    return {
      bar: region('[data-titlebar]'),
      meters: region('[data-plan-meters]'),
      meter: region('[data-plan-meter-root]')
    }
  })
  expect(regions.bar).toBe('drag')
  // The container that holds the meters stretches across the bar: it must not block dragging.
  expect(regions.meters).not.toBe('no-drag')
  // Each meter is clickable, so it opts out of dragging.
  expect(regions.meter).toBe('no-drag')

  // The stretch of the bar left of the meters is empty bar, not a button: the point there is not inside any control.
  const hit = await page.evaluate(() => {
    const bar = document.querySelector('[data-titlebar]')!.getBoundingClientRect()
    const first = document.querySelector('[data-plan-meter-root]')!.getBoundingClientRect()
    const el = document.elementFromPoint((first.left + bar.left) / 2, bar.top + bar.height / 2)
    return { inControl: Boolean(el?.closest('button, [data-plan-meter-root]')) }
  })
  expect(hit.inControl).toBe(false)
})
