// @spec: 010-cursor-as-a-third-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { NEEDS_ATTENTION, openSettings } from './codex-rig'
import {
  cursorPermissionAnswers,
  cursorPrompts,
  cursorShellRuns,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 section 2.4 (Slice 3): risky Cursor actions come to the user, or are blocked with a note. The brain is
 * the fake Claude CLI and the worker is the fake Cursor in `acp` mode; no model call is made.
 */

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const W1 = 'W1 · review'
const PUSH = 'git push origin HEAD'
const badge = (page: Page) => page.getByRole('button', { name: NEEDS_ATTENTION })
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

async function setup(cursorScenario: string): Promise<CursorRig> {
  const r = await launchCursorRig({ cursorScenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Review the work', mode: 'Autonomous' })
  return r
}

const pushAnswers = (r: CursorRig) =>
  cursorPermissionAnswers(r).filter((a) => a.toolCallId === 'push-1')
const ranPush = (r: CursorRig) => cursorShellRuns(r).some((s) => s.cmd === PUSH)

test('2.4: a Cursor worker asks to push; Needs attention shows the exact command and nothing runs until Approve', async () => {
  const r = await setup('cr-push')
  const { page } = r

  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText(PUSH)

  // Waiting: the fake Cursor has no answer and has not run the push.
  await page.waitForTimeout(1000)
  expect(pushAnswers(r)).toEqual([])
  expect(ranPush(r)).toBe(false)

  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(badge(page)).toHaveCount(0)
  // Allowed once (never "allow always"), and only then the push ran.
  await expect
    .poll(() => pushAnswers(r))
    .toEqual([{ toolCallId: 'push-1', outcome: 'selected', optionId: 'allow-once' }])
  await expect.poll(() => ranPush(r)).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: a refused Cursor push answers reject-once and the next prompt starts with the decline', async () => {
  const r = await setup('cr-push-deny')
  const { page } = r

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText(PUSH)
  await dialog.getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(badge(page)).toHaveCount(0)

  await expect
    .poll(() => pushAnswers(r))
    .toEqual([{ toolCallId: 'push-1', outcome: 'selected', optionId: 'reject-once' }])
  expect(ranPush(r)).toBe(false)

  // The worker ended its turn without report_done; Arc's next prompt to it carries the decline first.
  await expect.poll(() => cursorPrompts(r).filter((p) => p.role === 'worker').length).toBe(2)
  const next = cursorPrompts(r).filter((p) => p.role === 'worker')[1]!
  expect(next.text.startsWith(`[Arc] Your request to run \`${PUSH}\` was declined`)).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: an ordinary command in the Cursor worker’s working copy runs without asking', async () => {
  const r = await setup('cr-unasked')
  const { page } = r

  const card = workerCard(page, W1)
  // Arc answered `git status` itself: allow-once, with no Needs attention item at any point.
  await expect
    .poll(async () => {
      expect(await badge(page).count()).toBe(0)
      return cursorPermissionAnswers(r)
    })
    .toEqual([{ toolCallId: 'status-1', outcome: 'selected', optionId: 'allow-once' }])
  await expect.poll(() => cursorShellRuns(r).some((s) => s.cmd === 'git status')).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expect(badge(page)).toHaveCount(0)
})

test('2.4: a push Cursor never asks about is blocked, and the event log shows a Blocked note naming the worker', async () => {
  const r = await setup('cr-blocked')
  const { page } = r

  const card = workerCard(page, W1)
  const note = eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })
  await expect(note).toHaveCount(1, { timeout: 20_000 })
  await expect(note).toHaveAttribute('data-event-kind', 'cursor-blocked')
  await expect(note).toContainText(`W1 couldn't run \`${PUSH}\`: Arc blocked it`)
  const chip = note.getByRole('button', { name: 'Show W1' })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(card.getByRole('button').first()).toBeFocused()

  // Nothing asked and nothing ran.
  expect(cursorPermissionAnswers(r)).toEqual([])
  expect(ranPush(r)).toBe(false)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test("2.4: Settings > Providers warns about the user's Cursor allow rule", async () => {
  const r = await launchCursorRig({
    cursorScenario: 'cr-worker',
    repos: [{ name: 'api' }],
    homeFiles: () => ({
      '.cursor/cli-config.json': JSON.stringify({ permissions: { allow: ['Shell(git push)'] } })
    })
  })
  rig = r
  const { page } = r
  // Main reads the temp HOME's ~/.cursor/cli-config.json.
  const report = (await page.evaluate(() => window.harness.invoke('providers:bypass', {}))) as {
    ok: boolean
    data?: { cursor?: { allowEntries: string[] } }
  }
  expect(report.data?.cursor?.allowEntries).toEqual(['Shell(git push)'])

  await openSettings(page)
  const warning = page.locator('[data-bypass-warning]')
  await expect(warning).toBeVisible()
  const cursor = warning.locator('[data-bypass-cursor]')
  await expect(cursor).toContainText("Cursor settings that can skip Arc's approvals")
  await expect(cursor.locator('[data-bypass-cursor-allow] li')).toHaveText(['Shell(git push)'])
})
