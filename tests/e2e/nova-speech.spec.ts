// @spec: 016-voice-companion
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, sendToBrain, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const DETAILS = 'The details are in the chat.'

/** Fake models and the fake speech engine, with the speakers muted. */
const FAKE_VOICE_ENV = { HARNESS_VOICE_MODELS: 'fake' }

/** Starts a session with the Nova panel open and the brain's first turn finished. */
async function openNova(scenario: string): Promise<{ r: Rig; page: Page; panel: Locator }> {
  // Launch args, not ELECTRON_EXTRA_LAUNCH_ARGS (which never reaches Chromium here), keep the tones off the speakers.
  const r = await launchRig({
    scenario,
    repos: [{ name: 'api' }],
    args: ['--mute-audio'],
    env: FAKE_VOICE_ENV
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  const panel = page.locator('[data-nova-panel]')
  await expect(panel).toBeVisible()
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'idle')
  return { r, page, panel }
}

function stateOf(panel: Locator): Locator {
  return panel.locator('[data-nova-state]')
}
const novaState = (panel: Locator): Promise<string | null> =>
  stateOf(panel).getAttribute('data-nova-state')
const lastSpoken = async (panel: Locator): Promise<string> =>
  (await stateOf(panel).getAttribute('data-nova-last-spoken')) ?? ''

test('2.3: a typed answer with code is spoken without the code, ends with the details line, then Idle', async () => {
  const { page, panel } = await openNova('nova-speak-code')
  await sendToBrain(page, 'Show the fix')
  await expect(page.getByText('That should do it.').first()).toBeVisible({ timeout: 30_000 })
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 10_000 })
  await expect(panel.getByRole('status')).toHaveText('Speaking')
  const spoken = await lastSpoken(panel)
  expect(spoken).toContain('Here is the fix for the bug.')
  expect(spoken).not.toContain('```')
  expect(spoken).not.toContain('retries')
  expect(spoken).not.toContain('configure')
  expect(spoken.endsWith(DETAILS)).toBe(true)
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })
  await expect(panel.getByRole('status')).toHaveText('Idle')
})

test('2.3: Stop during speech returns to Idle at once', async () => {
  const { page, panel } = await openNova('nova-speak-long')
  await sendToBrain(page, 'Tell me a lot')
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
  const stop = panel.getByRole('button', { name: 'Stop' })
  await expect(stop).toBeEnabled()
  await stop.click()
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'idle', { timeout: 500 })
  // It stays quiet: the tone does not start again.
  await page.waitForTimeout(1000)
  expect(await novaState(panel)).toBe('idle')
})

test('2.3: Mute makes the next answer silent and stays on after the panel is reopened', async () => {
  const { page, panel } = await openNova('nova-speak-plain')
  const novaButton = page.getByRole('button', { name: 'Nova', exact: true })
  const mute = panel.getByRole('button', { name: 'Mute' })
  await mute.click()
  await expect(mute).toHaveAttribute('aria-pressed', 'true')
  const before = await lastSpoken(panel)

  await sendToBrain(page, 'Second question')
  await expect(page.getByText('Here is a plain second answer.')).toBeVisible({ timeout: 30_000 })
  const states = new Set<string>()
  for (let i = 0; i < 10; i++) {
    states.add((await novaState(panel)) ?? '')
    await page.waitForTimeout(100)
  }
  expect(states.has('speaking')).toBe(false)
  expect(await novaState(panel)).toBe('idle')
  expect(await lastSpoken(panel)).toBe(before)

  // Close and reopen: Mute is still on.
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toHaveCount(0)
  await novaButton.click()
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true')

  // Unmuting brings speech back.
  await panel.getByRole('button', { name: 'Mute' }).click()
  await expect(panel.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false')
  await sendToBrain(page, 'Third question')
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
})

test('2.3: with "Only answers to spoken questions" a typed answer is not spoken', async () => {
  const { page, panel } = await openNova('nova-speak-plain')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Voice' }).click()
  await page.getByLabel('Only answers to spoken questions').check()
  await expect(page.getByLabel('Only answers to spoken questions')).toBeChecked()
  // Back to the session; open the panel again if leaving Settings closed it.
  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
  if ((await panel.count()) === 0)
    await page.getByRole('button', { name: 'Nova', exact: true }).click()
  await expect(panel).toBeVisible()

  await sendToBrain(page, 'Second question')
  await expect(page.getByText('Here is a plain second answer.')).toBeVisible({ timeout: 30_000 })
  const states = new Set<string>()
  for (let i = 0; i < 10; i++) {
    states.add((await novaState(panel)) ?? '')
    await page.waitForTimeout(100)
  }
  expect(states.has('speaking')).toBe(false)
  expect(await lastSpoken(panel)).toBe('')
})

test('2.3: a plan that leaves the brain waiting is still spoken', async () => {
  const { page, panel } = await openNova('nova-plan-waiting')
  await sendToBrain(page, 'Plan the retry work')
  await expect(page.locator('[data-plan-card="proposed"]')).toBeVisible({ timeout: 30_000 })
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 10_000 })
  expect(await lastSpoken(panel)).toContain('I suggest one worker')
  await expect(stateOf(panel)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })
  // The plan still awaits approval.
  await expect(page.locator('[data-plan-card="proposed"]')).toBeVisible()
})
