// @spec: 016-voice-companion
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { expectWaiting, approve, request } from './attention-rig'
import { createGroupWithProjects, launchRig, sendToBrain, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const ATTENTION = 'I need your attention on something.'
const BRAIN_ERROR = 'Something went wrong. The details are in the chat.'

/** Starts a session whose first turn has finished. The Nova panel is not open yet. */
async function startReady(scenario: string): Promise<{ r: Rig; page: Page }> {
  const r = await launchRig({
    scenario,
    repos: [{ name: 'api' }],
    args: ['--mute-audio'],
    env: { HARNESS_VOICE_MODELS: 'fake' }
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(r.page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  return { r, page: r.page }
}

const panelOf = (page: Page): Locator => page.locator('[data-nova-panel]')
const stateOf = (page: Page): Locator => panelOf(page).locator('[data-nova-state]')

async function openNova(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  await expect(panelOf(page)).toBeVisible()
  await expect(stateOf(page)).toHaveAttribute('data-nova-state', 'idle')
}

/**
 * Every sentence Nova started to say, in order. With stub models the panel lists them in data-nova-spoken-log
 * (the last-spoken attribute alone cannot show a sentence said twice, and Nova may say an alert while it still
 * shows Thinking). The list lives in the store, so it survives the panel being closed and reopened.
 */
async function spoken(page: Page): Promise<string[]> {
  const raw = await page
    .locator('[data-nova-spoken-log]')
    .first()
    .getAttribute('data-nova-spoken-log')
  return JSON.parse(raw ?? '[]') as string[]
}
const timesSaid = async (page: Page, text: string): Promise<number> =>
  (await spoken(page)).filter((s) => s === text).length

/** Long enough for a sentence of this length to start and finish, and for a wrongly repeated one to show. */
const SETTLE_MS = 3000

test('2.5: an approval asked while the panel is open is announced once, and a second render does not repeat it', async () => {
  const { page } = await startReady('nova-announce')
  await openNova(page)

  await sendToBrain(page, 'Start the worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await expect.poll(() => timesSaid(page, ATTENTION), { timeout: 15_000 }).toBe(1)
  await expect(stateOf(page)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })
  // The badge shows as it always does.
  await expect(request(page, 'permission')).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Brain/ })).toBeVisible()

  // Render again: leave the session for Settings and come back, then close and reopen the panel.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
  await expectWaiting(page, 1)
  if ((await panelOf(page).count()) === 0) await openNova(page)
  await panelOf(page).getByRole('button', { name: 'Close' }).click()
  await expect(panelOf(page)).toHaveCount(0)
  await openNova(page)
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, ATTENTION)).toBe(1)
  await expectWaiting(page, 1)

  // Answering it says nothing more about attention.
  await approve(request(page, 'permission'))
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, ATTENTION)).toBe(1)
})

test('2.5: an approval already waiting before the panel opens is not announced', async () => {
  const { page } = await startReady('nova-announce')
  // Open and close once so the voice models are known before the approval arrives; the panel is then closed.
  await openNova(page)
  await panelOf(page).getByRole('button', { name: 'Close' }).click()
  await expect(panelOf(page)).toHaveCount(0)
  await sendToBrain(page, 'Start the worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await openNova(page)
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, ATTENTION)).toBe(0)
  await expectWaiting(page, 1)

  // Still silent when it is answered and the worker moves on.
  await approve(request(page, 'permission'))
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, ATTENTION)).toBe(0)
})

test('2.5: muted, a new approval is not said, the badge still shows, and unmuting does not replay it', async () => {
  const { page } = await startReady('nova-announce')
  await openNova(page)
  const mute = panelOf(page).getByRole('button', { name: 'Mute' })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')

  await sendToBrain(page, 'Start the worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await page.waitForTimeout(SETTLE_MS)
  expect(await spoken(page)).toEqual([])
  await expect(stateOf(page)).toHaveAttribute('data-nova-state', 'idle')
  await expect(request(page, 'permission')).toBeVisible()

  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'false')
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, ATTENTION)).toBe(0)
  await expect(stateOf(page)).toHaveAttribute('data-nova-state', 'idle')
})

test('2.5: a brain that stops unexpectedly is announced once and Nova returns to Idle', async () => {
  const { page } = await startReady('nova-error')
  await openNova(page)

  await sendToBrain(page, 'Break it')
  await expect.poll(() => timesSaid(page, BRAIN_ERROR), { timeout: 15_000 }).toBe(1)
  await expect(stateOf(page)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })
  await expect(panelOf(page).getByRole('status')).toHaveText('Idle')
  await page.waitForTimeout(SETTLE_MS)
  expect(await timesSaid(page, BRAIN_ERROR)).toBe(1)
  expect(await timesSaid(page, ATTENTION)).toBe(0)
  // The chat itself carries the error, once, and Nova never reads that notice aloud.
  const notice = page.locator('[data-error-notice]')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('The brain stopped unexpectedly: the brain crashed')
  expect((await spoken(page)).filter((t) => t.includes('stopped unexpectedly'))).toEqual([])
})
