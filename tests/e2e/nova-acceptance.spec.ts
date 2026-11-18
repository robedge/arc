// @spec: 016-voice-companion
// @regression
// Whole-feature flows against functional-spec.md that the per-slice specs (nova-panel, nova-speech,
// nova-listen, nova-bargein, nova-face, nova-announce, voice-models) do not assert end to end.
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  createGroupWithProjects,
  launchRig,
  sendToBrain,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const RATE = 16_000
const SPEECH_WAV = resolve('tests/e2e/fixtures/audio/speech.wav')
const SAID = 'Give me a status update'
const BRAIN_ERROR = 'Something went wrong. The details are in the chat.'
const SHORT_ANSWER = 'Here is a short answer.'

/** The samples of the fixture's speech (macOS `say`; the words run from about 0.3 s to 2.4 s). */
function speechSamples(fromSeconds: number, toSeconds: number): Int16Array {
  const bytes = readFileSync(SPEECH_WAV)
  const data = bytes.indexOf('data') + 8
  const all = new Int16Array(
    bytes.buffer.slice(
      bytes.byteOffset + data,
      bytes.byteOffset + bytes.length - ((bytes.length - data) % 2)
    )
  )
  return all.slice(Math.round(fromSeconds * RATE), Math.round(toSeconds * RATE))
}

/** Writes a 16 kHz mono WAV. Chromium's fake microphone loops it. */
function writeWav(name: string, samples: Int16Array): string {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + samples.length * 2, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(RATE * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(samples.length * 2, 40)
  const path = join(tmpdir(), `arc-nova-${name}-${process.pid}.wav`)
  writeFileSync(path, Buffer.concat([header, Buffer.from(samples.buffer)]))
  return path
}

/** The speech repeated every `periodSeconds`, starting half a second into each period. */
function loopWav(name: string, speech: Int16Array, periodSeconds: number): string {
  const samples = new Int16Array(Math.round(periodSeconds * RATE))
  samples.set(speech, Math.round(0.5 * RATE))
  return writeWav(name, samples)
}

const silenceWav = (seconds: number): string =>
  writeWav('silence', new Int16Array(Math.round(seconds * RATE)))

interface Options {
  scenario: string
  /** The audio the fake microphone plays. Without it no fake microphone exists. */
  wav?: string
  transcript?: string
}

/** Starts a session with the Nova panel open, idle. Fake models, speech engine and microphone; no sound. */
async function openNova(
  options: Options
): Promise<{ r: Rig; page: Page; panel: Locator; state: Locator }> {
  const { scenario, wav, transcript = SAID } = options
  const flags = ['--mute-audio']
  // Launch args, not ELECTRON_EXTRA_LAUNCH_ARGS (which never reaches Chromium here). The fake audio
  // file needs --no-sandbox in this setup.
  if (wav) {
    flags.push(
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--no-sandbox'
    )
  }
  const r = await launchRig({
    scenario,
    repos: [{ name: 'api' }],
    args: flags,
    env: {
      HARNESS_VOICE_MODELS: 'fake',
      HARNESS_VOICE_ENGINE: 'fake',
      HARNESS_FAKE_TRANSCRIPT: transcript
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

interface Sample {
  /** performance.now() in the page. */
  t: number
  /** The panel's state, or `closed` when there is no panel. */
  state: string
  /** Audio buffer sources that have started and not ended: what is audible. */
  playing: number
  /** The cyan glow the portrait shows (0 to 1). */
  glow: number
  /** The `data-nova-pose` text, or ''. */
  pose: string
}
interface Probe {
  samples: Sample[]
  /** Every button the user clicked, with the page time of the click. */
  clicks: { label: string; t: number }[]
  /** The page time each time another copy of the short answer appeared in the chat. */
  answers: number[]
}

/** Samples the page every 20 ms. Counts playing sources by wrapping `AudioBufferSourceNode`. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate((answer) => {
    const w = window as unknown as { __probe: Probe; __playing: number }
    const probe: Probe = { samples: [], clicks: [], answers: [] }
    w.__probe = probe
    w.__playing = 0
    const proto = AudioBufferSourceNode.prototype
    const start = proto.start
    proto.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
      w.__playing += 1
      this.addEventListener('ended', () => (w.__playing -= 1), { once: true })
      return start.apply(this, args)
    }
    document.addEventListener(
      'click',
      (e) => {
        const button = (e.target as Element).closest('button')
        if (button) {
          const label = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
          probe.clicks.push({ label, t: performance.now() })
        }
      },
      true
    )
    let seen = 0
    new MutationObserver(() => {
      const count = (document.body.textContent ?? '').split(answer).length - 1
      while (seen < count) {
        seen += 1
        probe.answers.push(performance.now())
      }
    }).observe(document.body, { childList: true, characterData: true, subtree: true })
    setInterval(() => {
      const portrait = document.querySelector<HTMLElement>('[data-nova-portrait]')
      probe.samples.push({
        t: performance.now(),
        state:
          document.querySelector('[data-nova-state]')?.getAttribute('data-nova-state') ?? 'closed',
        playing: w.__playing,
        glow: Number(portrait?.style.getPropertyValue('--nova-glow') || 0),
        pose: document.querySelector('[data-nova-pose]')?.getAttribute('data-nova-pose') ?? ''
      })
    }, 20)
  }, SHORT_ANSWER)
}

const probeOf = (page: Page): Promise<Probe> =>
  page.evaluate(() => (window as unknown as { __probe: Probe }).__probe)

/**
 * Milliseconds from the user's last click on `label` to the first moment nothing is audible and
 * nothing is heard again for the next 1.5 seconds (a gap between two sentences does not count).
 */
async function silenceAfterClick(page: Page, label: string): Promise<number> {
  let found = -1
  await expect
    .poll(
      async () => {
        const probe = await probeOf(page)
        const click = probe.clicks.filter((c) => c.label === label).at(-1)
        if (!click) return false
        const after = probe.samples.filter((s) => s.t >= click.t)
        const quiet = after.find(
          (s) =>
            s.playing === 0 &&
            after.at(-1)!.t >= s.t + 1500 &&
            after.every((o) => o.t < s.t || o.t > s.t + 1500 || o.playing === 0)
        )
        if (quiet) found = quiet.t - click.t
        return quiet !== undefined
      },
      { timeout: 8000, intervals: [100], message: `silence after clicking ${label}` }
    )
    .toBe(true)
  return found
}

const playingNow = async (page: Page): Promise<number> =>
  (await probeOf(page)).samples.at(-1)?.playing ?? 0

/** Sends the question that gets the long answer, and waits until it is audible. */
async function askForLongAnswer(page: Page, state: Locator): Promise<void> {
  await sendToBrain(page, 'Tell me a lot')
  await expect(state).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
  await expect.poll(() => playingNow(page), { timeout: 10_000 }).toBeGreaterThan(0)
}

const spokenMarkers = (page: Page): Locator => page.locator('[data-spoken-marker]')

async function resize(r: Rig, w: number, h: number): Promise<void> {
  await r.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]!
      win.setMinimumSize(300, 300)
      win.setSize(size[0]!, size[1]!)
    },
    [w, h]
  )
}

test('2.1: with the panel open, a worker can still be opened and the chat still works', async () => {
  const r = await launchRig({
    scenario: 'nova-panel',
    repos: [{ name: 'api' }],
    args: ['--mute-audio'],
    env: { HARNESS_VOICE_MODELS: 'fake' }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  // Wide enough for the chat, Nova and the Brain and workers column together.
  await resize(r, 1700, 1000)
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  const panel = page.locator('[data-nova-panel]')
  await expect(panel).toBeVisible()

  const card = workerCard(page, 'nova-edit')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await card.getByRole('button', { name: /^Details for/ }).click()
  await expect(page.locator('[data-worker-details]')).toBeVisible()
  await expect(panel).toBeVisible()

  await sendToBrain(page, 'Hello with the panel open')
  await expect(page.getByText('Panel reply received.')).toBeVisible({ timeout: 30_000 })
})

test('2.1 and 2.3: Mute, Close and switching session each silence a long answer within half a second', async () => {
  test.setTimeout(150_000)
  const { page, panel, state } = await openNova({ scenario: 'nova-long-repeat' })
  await installProbe(page)
  const novaButton = page.getByRole('button', { name: 'Nova', exact: true })

  // Mute while Nova speaks: the speech stops and Mute shows it is on.
  await askForLongAnswer(page, state)
  await panel.getByRole('button', { name: 'Mute' }).click()
  expect(await silenceAfterClick(page, 'Mute')).toBeLessThan(500)
  await expect(panel.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true')
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  await panel.getByRole('button', { name: 'Mute' }).click()
  await expect(panel.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false')

  // Close while Nova speaks: the panel goes and so does the sound.
  await askForLongAnswer(page, state)
  await panel.getByRole('button', { name: 'Close' }).click()
  expect(await silenceAfterClick(page, 'Close')).toBeLessThan(500)
  await expect(panel).toHaveCount(0)

  // Switch session while Nova speaks: the panel closes and the sound stops.
  await novaButton.click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  await askForLongAnswer(page, state)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  expect(await silenceAfterClick(page, 'Sessions')).toBeLessThan(500)
  await expect(novaButton).toHaveCount(0)
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
  await expect(panel).toHaveCount(0)
  expect(await playingNow(page)).toBe(0)
})

test('2.3: during a conversation Stop goes back to Listening and End conversation silences Nova', async () => {
  test.setTimeout(150_000)
  const { page, panel, state } = await openNova({
    scenario: 'nova-long-repeat',
    wav: silenceWav(30)
  })
  await installProbe(page)
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })

  // Stop: speech stops within half a second and the conversation carries on listening.
  await askForLongAnswer(page, state)
  await panel.getByRole('button', { name: 'Stop' }).click()
  expect(await silenceAfterClick(page, 'Stop')).toBeLessThan(500)
  await expect(state).toHaveAttribute('data-nova-state', 'listening')
  await expect(panel.getByRole('status').filter({ hasText: 'Listening' })).toBeVisible()
  expect(await playingNow(page)).toBe(0)

  // End conversation while Nova speaks: speech stops and the panel shows Idle.
  await askForLongAnswer(page, state)
  await panel.getByRole('button', { name: 'End conversation' }).click()
  expect(await silenceAfterClick(page, 'End conversation')).toBeLessThan(500)
  await expect(state).toHaveAttribute('data-nova-state', 'idle')
  await expect(panel.getByRole('status')).toHaveText('Idle')
})

test('2.2 and 2.3: five spoken turns in a row with one click, and each answer is spoken within 2 seconds', async () => {
  test.setTimeout(240_000)
  // Two seconds of speech every eight seconds, so the next question follows each answer without a click.
  const wav = loopWav('five', speechSamples(0.29, 2.4), 8)
  const { page, panel, state } = await openNova({ scenario: 'nova-listen', wav })
  await installProbe(page)

  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  // The only click: five questions reach the chat as spoken messages and get answers.
  await expect
    .poll(async () => (await probeOf(page)).answers.length, { timeout: 200_000, intervals: [500] })
    .toBeGreaterThanOrEqual(5)
  expect(await spokenMarkers(page).count()).toBeGreaterThanOrEqual(5)

  const probe = await probeOf(page)
  const clicks = probe.clicks.map((c) => c.label)
  expect(clicks, 'nothing but Start conversation was clicked').toEqual(['Start conversation'])
  const first = probe.samples.findIndex((s) => s.state === 'listening')
  expect(
    probe.samples.slice(first).some((s) => s.state === 'idle'),
    'the conversation never dropped out of the loop'
  ).toBe(false)
  // Each of the first five answers is audible, with the panel showing Speaking, within 2 seconds of arriving in the chat.
  for (const arrived of probe.answers.slice(0, 5)) {
    const speaking = probe.samples.find(
      (s) => s.t >= arrived && s.state === 'speaking' && s.playing > 0
    )
    expect(speaking, 'Nova speaks the answer aloud').toBeDefined()
    expect(speaking!.t - arrived).toBeLessThan(2000)
  }
  await panel.getByRole('button', { name: 'End conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 5000 })
})

test('2.4: the cyan lights follow the voice while listening, and still change when the face is held still by reduced motion', async () => {
  test.setTimeout(120_000)
  const { page, panel, state } = await openNova({
    scenario: 'nova-listen',
    wav: loopWav('glow', speechSamples(0.29, 2.4), 8)
  })
  await installProbe(page)
  const start = panel.getByRole('button', { name: 'Start conversation' })
  const reset = (): Promise<void> =>
    page.evaluate(() => {
      ;(window as unknown as { __probe: Probe }).__probe.samples.length = 0
    })
  const listening = async (): Promise<Sample[]> =>
    (await probeOf(page)).samples.filter((s) => s.state === 'listening')
  const range = (samples: Sample[]): { low: number; high: number } => ({
    low: Math.min(...samples.map((s) => s.glow)),
    high: Math.max(...samples.map((s) => s.glow))
  })

  // Normal motion: the glow rises with the user's voice and falls in the pauses.
  await expect.poll(async () => (await probeOf(page)).samples.length).toBeGreaterThan(5)
  const idleGlow = (await probeOf(page)).samples.at(-1)!.glow
  await start.click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await expect
    .poll(async () => range(await listening()).high - range(await listening()).low, {
      timeout: 30_000,
      message: 'the glow moves with the voice'
    })
    .toBeGreaterThan(0.25)
  expect(range(await listening()).high).toBeGreaterThan(idleGlow + 0.25)
  await panel.getByRole('button', { name: 'End conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 5000 })

  // Reduced motion: the face stays at its base pose, the label says Listening, and the glow still moves.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')
  await reset()
  await start.click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await expect
    .poll(async () => range(await listening()).high - range(await listening()).low, {
      timeout: 30_000,
      message: 'the glow moves with the voice under reduced motion'
    })
    .toBeGreaterThan(0.25)
  const all = (await probeOf(page)).samples.filter((s) => s.pose !== '')
  expect(all.length).toBeGreaterThan(0)
  expect(new Set(all.map((s) => s.pose)).size, 'the face never moved').toBe(1)
  await panel.getByRole('button', { name: 'End conversation' }).click()
})

test('2.5: a brain error during a conversation is announced and Nova goes back to Listening', async () => {
  test.setTimeout(120_000)
  const { page, panel, state } = await openNova({
    scenario: 'nova-error',
    wav: loopWav('error', speechSamples(0.29, 2.4), 40),
    transcript: 'Break it'
  })
  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  const said = async (): Promise<string[]> =>
    JSON.parse(
      (await page.locator('[data-nova-spoken-log]').first().getAttribute('data-nova-spoken-log')) ??
        '[]'
    ) as string[]
  await expect
    .poll(async () => (await said()).filter((s) => s === BRAIN_ERROR).length, { timeout: 60_000 })
    .toBe(1)
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 30_000 })
  await expect(panel.getByRole('status')).toHaveText('Listening')
  expect((await said()).filter((s) => s === BRAIN_ERROR)).toHaveLength(1)
  // The error is in the chat too, once, and was not read aloud.
  const notice = page.locator('[data-error-notice]')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('The brain stopped unexpectedly: the brain crashed')
  expect((await said()).filter((s) => s.includes('stopped unexpectedly'))).toEqual([])
})
