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

interface Pose {
  mouthLevel: number
  mouthOpen: number
  blink: string | null
  glance: string | null
}
interface Sample {
  state: string
  pose: Pose
}
const BASE: Pose = { mouthLevel: 0, mouthOpen: 0, blink: null, glance: null }

/** Starts a session with the Nova panel open, idle, and a sampler recording every state and pose change. */
async function openNova(): Promise<{ page: Page; panel: Locator }> {
  const r = await launchRig({
    scenario: 'nova-face',
    repos: [{ name: 'api' }],
    // Launch args keep the tones off the speakers.
    args: ['--mute-audio'],
    env: { HARNESS_VOICE_MODELS: 'fake' }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  const panel = page.locator('[data-nova-panel]')
  await expect(panel.locator('[data-nova-state]')).toHaveAttribute('data-nova-state', 'idle')
  await expect(panel.locator('[data-nova-pose]')).toHaveCount(1, { timeout: 10_000 })
  await page.evaluate(() => {
    const w = window as unknown as { __novaSamples: unknown[] }
    w.__novaSamples = []
    const record = (): void => {
      const state = document.querySelector('[data-nova-state]')?.getAttribute('data-nova-state')
      const pose = document.querySelector('[data-nova-pose]')?.getAttribute('data-nova-pose')
      if (state && pose) w.__novaSamples.push({ state, pose: JSON.parse(pose) })
    }
    // Every change of either attribute, plus a steady tick, so short blinks and mouth steps are seen.
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-nova-pose', 'data-nova-state']
    })
    setInterval(record, 25)
  })
  return { page, panel }
}

const samples = (page: Page): Promise<Sample[]> =>
  page.evaluate(() => (window as unknown as { __novaSamples: Sample[] }).__novaSamples)
const mark = async (page: Page): Promise<number> => (await samples(page)).length
const since = async (page: Page, from: number): Promise<Sample[]> =>
  (await samples(page)).slice(from)

const stateAttr = (panel: Locator): Locator => panel.locator('[data-nova-state]')

test('2.4: idle blinks within 10 s; thinking glances; speaking moves the mouth and it closes after', async () => {
  test.setTimeout(120_000)
  const { page, panel } = await openNova()

  // Idle: a blink appears within 10 s, and nothing else moves.
  await expect
    .poll(async () => (await samples(page)).some((s) => s.state === 'idle' && s.pose.blink), {
      timeout: 10_000,
      intervals: [100]
    })
    .toBe(true)
  const idle = await samples(page)
  expect(idle.every((s) => s.pose.mouthLevel === 0 && s.pose.glance === null)).toBe(true)
  await panel.screenshot({ path: 'docs/screenshots/nova-face-idle.png' })

  // Thinking: the brain pauses for 7 s, so the glance takes at least two distinct values.
  const thinkingFrom = await mark(page)
  await sendToBrain(page, 'Think first')
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'thinking', { timeout: 10_000 })
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
  const thinking = (await since(page, thinkingFrom)).filter((s) => s.state === 'thinking')
  const glances = new Set(thinking.map((s) => s.pose.glance))
  expect(glances.size).toBeGreaterThanOrEqual(2)
  expect(thinking.some((s) => s.pose.glance !== null)).toBe(true)
  expect(thinking.every((s) => s.pose.mouthLevel === 0)).toBe(true)

  // Speaking: the mouth opens while the tone plays.
  await expect
    .poll(
      async () =>
        (await samples(page)).some((s) => s.state === 'speaking' && s.pose.mouthLevel > 0),
      { timeout: 10_000, intervals: [50] }
    )
    .toBe(true)
  await panel.screenshot({ path: 'docs/screenshots/nova-face-speaking.png' })

  // The fake speech has a gap of 200 ms or more after every third syllable, so the mouth opens on
  // the syllables and comes back to closed in those gaps while Nova is still speaking.
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })
  await expect
    .poll(async () => (await samples(page)).at(-1)?.pose.mouthLevel, { timeout: 2000 })
    .toBe(0)
  const all = await samples(page)
  const spoke = all.filter((s) => s.state === 'speaking')
  const opens = spoke.map((s) => s.pose.mouthOpen)
  expect(Math.max(...opens)).toBeGreaterThan(0.4)
  const firstOpen = opens.findIndex((o) => o > 0.4)
  const lastOpen = opens.findLastIndex((o) => o > 0.4)
  // Closed between two open stretches, not merely before and after.
  const closedBetween = opens.slice(firstOpen, lastOpen).filter((o) => o < 0.03).length
  expect(closedBetween).toBeGreaterThan(2)
  // It moves continuously: many distinct values, not a handful of steps.
  expect(new Set(opens.map((o) => o.toFixed(2))).size).toBeGreaterThan(8)
})

test('2.4: with reduced motion the pose stays at base while the state label changes', async () => {
  test.setTimeout(120_000)
  const { page, panel } = await openNova()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')

  // Idle for longer than the longest blink gap: no blink.
  await page.waitForTimeout(6500)
  const from = await mark(page)
  await sendToBrain(page, 'Think first')
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'thinking', { timeout: 10_000 })
  await expect(panel.getByRole('status')).toHaveText('Thinking')
  await page.waitForTimeout(4000)
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
  await expect(panel.getByRole('status')).toHaveText('Speaking')
  await page.waitForTimeout(1500)
  await expect(stateAttr(panel)).toHaveAttribute('data-nova-state', 'idle', { timeout: 30_000 })

  const all = await since(page, 0)
  expect(all.length).toBeGreaterThan(from)
  const states = new Set(all.map((s) => s.state))
  expect(states.has('thinking')).toBe(true)
  expect(states.has('speaking')).toBe(true)
  expect(all.every((s) => JSON.stringify(s.pose) === JSON.stringify(BASE))).toBe(true)
})
