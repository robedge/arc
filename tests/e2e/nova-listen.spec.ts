// @spec: 016-voice-companion
// @regression
import { writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, sendToBrain, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

/** Seven seconds of speech (macOS `say`, 16 kHz mono) followed by five seconds of silence. */
const SPEECH_WAV = resolve('tests/e2e/fixtures/audio/speech.wav')
const SAID = 'Give me a status update'

/** A 16 kHz mono WAV of digital silence, written at test time. */
function silenceWav(seconds: number): string {
  const samples = 16_000 * seconds
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples * 2, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16_000, 24)
  header.writeUInt32LE(32_000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples * 2, 40)
  const path = join(tmpdir(), `arc-nova-silence-${process.pid}.wav`)
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(samples * 2)]))
  return path
}

interface Options {
  wav?: string
  transcript?: string
  micStatus?: string
  /** Launch with Chromium's fake capture device playing `wav`; without it no fake microphone exists. */
  fakeMic?: boolean
}

/** Starts a session with the Nova panel open and the brain idle. Fake models, speech engine, microphone and no sound. */
async function openNova(
  options: Options = {}
): Promise<{ r: Rig; page: Page; panel: Locator; state: Locator }> {
  const { wav = SPEECH_WAV, transcript = SAID, micStatus, fakeMic = true } = options
  const flags = ['--mute-audio']
  // Passed as launch args (ELECTRON_EXTRA_LAUNCH_ARGS never reaches Chromium here). The fake audio file
  // needs --no-sandbox in this setup, and it loops, so a turn can repeat.
  if (fakeMic) {
    flags.push(
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--no-sandbox'
    )
  }
  const r = await launchRig({
    scenario: 'nova-listen',
    repos: [{ name: 'api' }],
    args: flags,
    env: {
      HARNESS_VOICE_MODELS: 'fake',
      HARNESS_VOICE_ENGINE: 'fake',
      HARNESS_FAKE_TRANSCRIPT: transcript,
      ...(micStatus ? { HARNESS_MIC_STATUS: micStatus } : {})
    }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  const panel = page.locator('[data-nova-panel]')
  await expect(panel).toBeVisible()
  const state = panel.locator('[data-nova-state]')
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  return { r, page, panel, state }
}

const spokenMarkers = (page: Page): Locator => page.locator('[data-spoken-marker]')

test('2.2: Start conversation listens; a spoken turn is sent with the spoken marker, then Thinking, Speaking and Listening again', async () => {
  const { page, panel, state } = await openNova()
  // Record every state the panel shows from here on.
  await state.evaluate((el) => {
    const seen: string[] = [el.getAttribute('data-nova-state') ?? '']
    ;(window as unknown as { __novaSeen: string[] }).__novaSeen = seen
    new MutationObserver(() => {
      const next = el.getAttribute('data-nova-state') ?? ''
      if (seen[seen.length - 1] !== next) seen.push(next)
    }).observe(el, { attributes: true, attributeFilter: ['data-nova-state'] })
  })

  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await expect(panel.getByRole('status').filter({ hasText: 'Listening' })).toBeVisible()

  // After the fixture's pause the words reach the chat as a spoken message.
  await expect(page.getByText(SAID).first()).toBeVisible({ timeout: 30_000 })
  await expect(spokenMarkers(page).first()).toBeVisible()
  await expect(page.getByText('Here is a short answer.').first()).toBeVisible({ timeout: 30_000 })

  await expect
    .poll(
      async () => {
        const seen = await page.evaluate(
          () => (window as unknown as { __novaSeen: string[] }).__novaSeen
        )
        const order = ['listening', 'thinking', 'speaking', 'listening']
        let at = 0
        for (const s of seen) if (s === order[at]) at += 1
        return at === order.length
      },
      { timeout: 30_000, message: 'listening, thinking, speaking, listening in that order' }
    )
    .toBe(true)
  await expect(state).toHaveAttribute('data-nova-state', /listening|thinking|speaking/)

  // End conversation stops everything.
  await panel.getByRole('button', { name: 'End conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 5000 })
})

test('2.2: ten seconds of silence return Nova to Idle', async () => {
  const { page, panel, state } = await openNova({ wav: silenceWav(6) })
  // Fake timers: the page's clock runs from now and jumps ten seconds once Nova listens.
  await page.clock.install()
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await page.clock.fastForward(9_000)
  await expect(state).toHaveAttribute('data-nova-state', 'listening')
  await page.clock.fastForward(2_000)
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 5000 })
  await expect(spokenMarkers(page)).toHaveCount(0)
})

test('2.2: Cancel sends nothing and goes Idle', async () => {
  const { r, page, panel, state } = await openNova()
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  // Wait until the fixture's speech is audible (the level meter moves), so a turn is in progress.
  await expect
    .poll(
      async () =>
        Number((await panel.locator('[data-nova-level]').getAttribute('data-nova-level')) ?? 0),
      {
        timeout: 15_000
      }
    )
    .toBeGreaterThan(0.2)
  await page.waitForTimeout(500)
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 2000 })
  // Long enough for the fixture's speech and pause to have gone by.
  await page.waitForTimeout(9000)
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  await expect(spokenMarkers(page)).toHaveCount(0)
  await expect(page.getByText(SAID)).toHaveCount(0)
  const log = await readFile(r.logPath, 'utf8')
  expect(log).not.toContain(SAID)
})

test('2.2: speech that is not understood gets "Sorry, I didn\'t catch that." and Nova keeps listening', async () => {
  const { page, panel, state } = await openNova({ transcript: '' })
  const seen: string[] = []
  await state.evaluate((el) => {
    ;(window as unknown as { __spoken: string[] }).__spoken = []
    new MutationObserver(() => {
      const said = el.getAttribute('data-nova-last-spoken') ?? ''
      const all = (window as unknown as { __spoken: string[] }).__spoken
      if (said && all[all.length - 1] !== said) all.push(said)
    }).observe(el, { attributes: true, attributeFilter: ['data-nova-last-spoken'] })
  })
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-last-spoken', "Sorry, I didn't catch that.", {
    timeout: 30_000
  })
  seen.push(...(await page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken)))
  expect(seen).toContain("Sorry, I didn't catch that.")
  await expect(state).toHaveAttribute('data-nova-state', /speaking|listening/)
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  // Nothing went to the brain.
  await expect(spokenMarkers(page)).toHaveCount(0)
})

test('2.5: without a microphone Nova says so, and a typed answer is still spoken', async () => {
  // The CI Mac may have a real microphone, so none is emulated: getUserMedia finds no device.
  const { page, panel, state } = await openNova({ fakeMic: false })
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Requested device not found', 'NotFoundError'))
  })
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(panel.locator('[data-nova-no-mic]')).toContainText('No microphone found.')
  await expect(state).toHaveAttribute('data-nova-state', 'idle')

  await sendToBrain(page, 'Typed question')
  await expect(page.getByText('Here is a short answer.').first()).toBeVisible({ timeout: 30_000 })
  await expect(state).toHaveAttribute('data-nova-state', 'speaking', { timeout: 10_000 })
  await expect(state).toHaveAttribute('data-nova-last-spoken', /Here is a short answer\./)
})

test('2.5: with the microphone denied Nova shows the message and a button for System Settings', async () => {
  const { r, panel, state } = await openNova({ micStatus: 'denied', fakeMic: false })
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  const denied = panel.locator('[data-nova-mic-denied]')
  await expect(denied).toContainText(
    "Arc can't hear you. Allow microphone access in System Settings > Privacy & Security > Microphone."
  )
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  const opens = (): Promise<number> =>
    r.app.evaluate(() =>
      (
        globalThis as unknown as { __e2e: { getMicSettingsOpens(): number } }
      ).__e2e.getMicSettingsOpens()
    )
  expect(await opens()).toBe(0)
  await denied.getByRole('button', { name: 'Open System Settings' }).click()
  await expect.poll(opens).toBe(1)
})
