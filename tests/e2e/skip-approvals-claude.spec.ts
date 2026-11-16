// @spec: 015-skip-all-approvals
// @regression
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 015 slice 7: a running Claude worker is replaced between turns (`--resume`, same conversation) when Skip all
 * approvals changes, because `--disallowedTools` is fixed at launch. The fake CLI logs each launch's argv.
 */

let rig: Rig | undefined
let gateDir: string | undefined
test.afterEach(async () => {
  // Lets any held fake process end before Arc is closed.
  if (gateDir !== undefined) {
    for (const g of ['gate1', 'gate2']) writeFileSync(join(gateDir, g), '')
  }
  await rig?.dispose()
  rig = undefined
  gateDir = undefined
})

const W1 = 'W1 · relaunch'
const skipSwitch = (page: Page) => page.getByLabel('Skip all approvals', { exact: true })
const skipDialog = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const skipMarker = (page: Page) => page.locator('[data-skip-approvals-on]')

async function turnSkipOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approvals' }).click()
  await skipSwitch(page).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(skipMarker(page)).toBeVisible()
  // Confirming closes the Approvals menu too, so the warning never sits under it.
  await expect(page.getByRole('dialog', { name: 'Approvals', exact: true })).toHaveCount(0)
}

async function turnSkipOff(page: Page): Promise<void> {
  await skipMarker(page).click()
  await page
    .getByRole('dialog', { name: 'Turn Skip all approvals off?' })
    .getByRole('button', { name: 'Turn off' })
    .click()
  await expect(skipMarker(page)).toHaveCount(0)
}

/** The argv of every worker launch the fake Claude logged, oldest first. */
function workerLaunches(r: Rig): string[][] {
  return readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is string[] => Array.isArray(a) && a.some((x) => String(x).includes('arc-role:worker'))
    )
}

function workerCwd(r: Rig): string | undefined {
  for (const l of readFakeLog(r)) {
    const sh = l['shell'] as { cmd?: string; out?: string } | undefined
    if (sh?.cmd === 'pwd') return sh.out?.trim()
  }
  return undefined
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The folders a launch denies edits in: the `Edit(//dir/**)` entries of its `--disallowedTools`. */
function deniedDirs(argv: string[]): string[] {
  const at = argv.indexOf('--disallowedTools')
  if (at === -1) return []
  const dirs: string[] = []
  for (const rule of argv.slice(at + 1)) {
    if (rule.startsWith('--')) break
    const m = /^Edit\(\/(.*)\/\*\*\)$/.exec(rule)
    if (m?.[1] !== undefined) dirs.push(m[1])
  }
  return dirs
}

const hasKnowledge = (dirs: string[]): boolean => dirs.some((d) => d.includes('/knowledge'))
const hasAttachments = (dirs: string[]): boolean => dirs.some((d) => d.includes('/attachments'))

test('015 2.5: skip turned on during turn one waits for the turn to end, then the worker resumes the same conversation without the knowledge deny; turning it off restores the denies at the next boundary', async () => {
  const r = await launchRig({
    scenario: 'skip-relaunch',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Run the relaunch checks', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await expect.poll(() => workerLaunches(r).length).toBe(1)
  // The fake worker's working copy (the output of its `pwd` step): the gate files live there.
  await expect.poll(() => workerCwd(r)).toBeTruthy()
  gateDir = workerCwd(r)
  const first = workerLaunches(r)[0]!
  expect(flag(first, '--resume')).toBeUndefined()
  // The conversation id the first process reported as its progress note, shown on the card.
  await expect(card).toContainText(/conversation=[0-9a-f-]{36}/)
  const sessionId = /conversation=([0-9a-f-]{36})/.exec((await card.textContent()) ?? '')?.[1]
  expect(sessionId).toBeTruthy()
  // Skip off: the knowledge folder and the attachments folder are both denied.
  expect(hasKnowledge(deniedDirs(first))).toBe(true)
  expect(hasAttachments(deniedDirs(first))).toBe(true)

  // Turn one is still open: skip on marks the worker but leaves its process alone.
  await turnSkipOn(page)
  await page.waitForTimeout(2000)
  expect(workerLaunches(r)).toHaveLength(1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')

  // The turn ends (no report_done): the nudge goes to a process that resumes the same conversation.
  writeFileSync(join(gateDir!, 'gate1'), '')
  await expect.poll(() => workerLaunches(r).length).toBe(2)
  const second = workerLaunches(r)[1]!
  expect(flag(second, '--resume')).toBe(sessionId)
  expect(hasKnowledge(deniedDirs(second))).toBe(false)
  expect(hasAttachments(deniedDirs(second))).toBe(true)
  // Only the attachments folder stays denied.
  expect(deniedDirs(second).every((d) => d.includes('/attachments'))).toBe(true)
  const nudged = readFakeLog(r).some((l) =>
    JSON.stringify(l['stdin'] ?? '').includes('You have not called report_done')
  )
  expect(nudged).toBe(true)

  // Turn two is held open. The user steps in, turns skip off and hands back: that is the next boundary.
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  await page.getByRole('button', { name: 'Step in', exact: true }).click()
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")
  await turnSkipOff(page)
  await page.waitForTimeout(1500)
  expect(workerLaunches(r)).toHaveLength(2)
  await page.getByRole('button', { name: 'Hand back', exact: true }).click()

  await expect.poll(() => workerLaunches(r).length).toBe(3)
  const third = workerLaunches(r)[2]!
  expect(flag(third, '--resume')).toBe(sessionId)
  expect(hasKnowledge(deniedDirs(third))).toBe(true)
  expect(hasAttachments(deniedDirs(third))).toBe(true)
  expect(deniedDirs(third)).toEqual(deniedDirs(first))
})
