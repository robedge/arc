// @spec: 008-plan-usage-and-token-spend
// @regression
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, startSession } from './sessions-rig'
import { inMinutes, reopenSession, resetText } from './usage-rig'

/**
 * Spec 008 section 2.4 (warnings part): a notice at 80% and a second one at 95%, each once per limit per reset
 * period, and the meter turning amber and red. The fake Claude CLI reads the plan numbers from a file on every turn, so
 * the test changes them between turns of one session. No model call is made.
 */

let rig: CodexRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const meter = (page: Page): Locator => page.locator('[data-plan-meter="claude"]')
const notices = (page: Page): Locator => page.locator('[data-plan-notice]')

/** Writes what the fake CLI reports for the 5-hour limit on its next turn (the weekly limit stays at 18%). */
function report(file: string, fraction: number, resetsAt: number): void {
  writeFileSync(
    file,
    JSON.stringify({
      five_hour: { utilization: fraction, resetsAt },
      seven_day: { utilization: 0.18, resetsAt: resetsAt + 6 * 86400 }
    })
  )
}

async function say(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('Message the brain')
  await input.fill(text)
  await input.press('Enter')
}

test('2.4: a notice at 80% and another at 95%, each shown once, with the meter turning amber and then red', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'arc-s8-'))
  const file = join(scratch, 'plan.json')
  const resetsAt = inMinutes(150)
  report(file, 0.79, resetsAt)
  const r = await launchCodexRig({
    scenario: 'us-turns',
    repos: [{ name: 'api' }],
    codexInstalled: false,
    env: { FAKE_CLAUDE_RATE_LIMIT_FILE: file }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Check the meter', mode: 'Autonomous' })

  // 79%: the meter shows it, plain, and there is no notice.
  await expect(meter(page)).toHaveAttribute('aria-label', /5h 79%/)
  await expect(meter(page)).toHaveAttribute('data-severity', 'ok')
  await expect(notices(page)).toHaveCount(0)

  // 81% on the next update: amber, and a notice that names the limit, says 80% and gives the reset time.
  report(file, 0.81, resetsAt)
  await say(page, 'two')
  await expect(meter(page)).toHaveAttribute('aria-label', /5h 81%/)
  await expect(meter(page)).toHaveAttribute('data-severity', 'warn')
  await expect(notices(page)).toHaveCount(1)
  await expect(notices(page)).toHaveText(
    `Claude's 5-hour limit is at 80%. It resets at ${resetText(resetsAt)}.`
  )

  // Dismissed, and the limit rises further but stays under 95%: nothing new appears.
  await page.getByRole('button', { name: /^Dismiss Claude 5-hour limit notice/ }).click()
  await expect(notices(page)).toHaveCount(0)
  report(file, 0.9, resetsAt)
  await say(page, 'three')
  await expect(meter(page)).toHaveAttribute('aria-label', /5h 90%/)
  await expect(meter(page)).toHaveAttribute('data-severity', 'warn')
  await page.waitForTimeout(1500)
  await expect(notices(page)).toHaveCount(0)

  // 96%: red, and a second notice.
  report(file, 0.96, resetsAt)
  await say(page, 'four')
  await expect(meter(page)).toHaveAttribute('aria-label', /5h 96%/)
  await expect(meter(page)).toHaveAttribute('data-severity', 'critical')
  await expect(notices(page)).toHaveCount(1)
  await expect(notices(page)).toHaveText(
    `Claude's 5-hour limit is at 95%. It resets at ${resetText(resetsAt)}.`
  )
  await expect(page.getByRole('alert').filter({ has: notices(page) })).toHaveCount(1)
})

test('2.4: a notice that was shown and dismissed does not come back when Arc opens again in the same reset period', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'arc-s8-'))
  const file = join(scratch, 'plan.json')
  const resetsAt = inMinutes(150)
  report(file, 0.81, resetsAt)
  const r = await launchCodexRig({
    scenario: 'us-turns',
    repos: [{ name: 'api' }],
    codexInstalled: false,
    env: { FAKE_CLAUDE_RATE_LIMIT_FILE: file }
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Check the meter', mode: 'Autonomous' })
  await expect(notices(r.page)).toHaveCount(1)
  await r.page.getByRole('button', { name: /^Dismiss Claude 5-hour limit notice/ }).click()
  await expect(notices(r.page)).toHaveCount(0)

  await r.relaunch()
  await reopenSession(r.page, 'Storefront', 'Meter session')
  // The meter remembers 81%; a new reading in the same period (82%) brings no new notice.
  await expect(meter(r.page)).toHaveAttribute('aria-label', /5h 81%/)
  report(file, 0.82, resetsAt)
  await say(r.page, 'two')
  await expect(meter(r.page)).toHaveAttribute('aria-label', /5h 82%/)
  await r.page.waitForTimeout(1500)
  await expect(notices(r.page)).toHaveCount(0)
})
