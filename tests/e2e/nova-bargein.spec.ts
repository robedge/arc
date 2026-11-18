// @spec: 016-voice-companion
// @regression
import { readFileSync, writeFileSync } from 'node:fs'
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

const RATE = 16_000
const SPEECH_WAV = resolve('tests/e2e/fixtures/audio/speech.wav')

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

/**
 * A 16 kHz mono WAV that repeats `speech` every `periodSeconds`. Chromium's fake microphone loops the
 * file, so speech arrives at a steady rhythm whatever moment the conversation starts.
 */
function loopWav(name: string, speech: Int16Array, periodSeconds: number): string {
  const samples = new Int16Array(Math.round(periodSeconds * RATE))
  samples.set(speech, Math.round(0.5 * RATE))
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

interface Options {
  wav: string
  scenario?: string
  transcript?: string
}

/** Starts a session with the Nova panel open. Fake models, speech engine and microphone; no sound. */
async function openNova(
  options: Options
): Promise<{ page: Page; panel: Locator; state: Locator; transcript: Locator }> {
  const { wav, scenario = 'nova-bargein', transcript = 'Open the settings panel now' } = options
  const r = await launchRig({
    scenario,
    repos: [{ name: 'api' }],
    // Launch args, not ELECTRON_EXTRA_LAUNCH_ARGS (which never reaches Chromium here). The fake audio
    // file needs --no-sandbox in this setup.
    args: [
      '--mute-audio',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--no-sandbox'
    ],
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
  return { page, panel, state, transcript: panel.locator('[data-nova-transcript]') }
}

interface Sample {
  /** performance.now() in the page. */
  t: number
  state: string
  /** Audio buffer sources that have started and not ended: what is audible. */
  playing: number
}

/**
 * Samples the panel every 20 ms: its state and how many playback sources are
 * active (counted by wrapping `AudioBufferSourceNode`, so it sees the real audio graph).
 */
async function startSampler(page: Page, panel: Locator): Promise<void> {
  await panel.evaluate((root) => {
    const w = window as unknown as { __samples: Sample[]; __playing: number }
    w.__samples = []
    w.__playing = 0
    const proto = AudioBufferSourceNode.prototype
    const start = proto.start
    proto.start = function (this: AudioBufferSourceNode, ...args: Parameters<typeof start>) {
      w.__playing += 1
      this.addEventListener('ended', () => (w.__playing -= 1), { once: true })
      return start.apply(this, args)
    }
    const stateEl = root.querySelector('[data-nova-state]')!
    setInterval(() => {
      w.__samples.push({
        t: performance.now(),
        state: stateEl.getAttribute('data-nova-state') ?? '',
        playing: w.__playing
      })
    }, 20)
  })
}

const samplesOf = (page: Page): Promise<Sample[]> =>
  page.evaluate(() => (window as unknown as { __samples: Sample[] }).__samples)

const spokenMarkers = (page: Page): Locator => page.locator('[data-spoken-marker]')

test('2.2: the words appear while the user speaks, one after another, then the final text', async () => {
  test.setTimeout(90_000)
  const SAID = 'Open the settings panel now'
  const { panel, state, transcript } = await openNova({
    wav: SPEECH_WAV,
    scenario: 'nova-listen',
    transcript: SAID
  })
  // Record every text the transcript line shows from here on, until the final text arrives.
  await transcript.evaluate((el, final) => {
    const seen: string[] = []
    ;(window as unknown as { __words: string[] }).__words = seen
    const watch = new MutationObserver(() => {
      const text = (el.textContent ?? '').trim()
      if (text && seen[seen.length - 1] !== text) seen.push(text)
      if (text === final) watch.disconnect()
    })
    watch.observe(el, { childList: true, characterData: true, subtree: true })
  }, SAID)

  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await expect
    .poll(
      () =>
        transcript.evaluate(
          () => (window as unknown as { __words: string[] }).__words.at(-1) ?? ''
        ),
      { timeout: 30_000, message: 'the final text shows' }
    )
    .toBe(SAID)

  const words = await transcript.evaluate(
    () => (window as unknown as { __words: string[] }).__words
  )
  const partials = words.slice(0, -1)
  expect(partials.length, `partials: ${JSON.stringify(words)}`).toBeGreaterThanOrEqual(2)
  // Live words are lowercase and each one extends the one before it.
  for (const [i, text] of partials.entries()) {
    expect(text).toBe(text.toLowerCase())
    if (i > 0) expect(text.startsWith(partials[i - 1]!)).toBe(true)
    expect(text.length).toBeGreaterThan(i > 0 ? partials[i - 1]!.length : 0)
  }
  expect(SAID.toLowerCase().startsWith(partials[0]!)).toBe(true)
  // The final text keeps its case.
  expect(words.at(-1)).toBe(SAID)
})

test('2.3: speaking over Nova for more than 400 ms stops her within half a second and starts a new turn', async () => {
  test.setTimeout(120_000)
  // Two seconds of speech every eight seconds: the first is the question, the next lands on Nova's long answer.
  const wav = loopWav('bargein', speechSamples(0.29, 2.4), 8)
  const { page, panel, state } = await openNova({ wav })
  await startSampler(page, panel)

  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  await expect(state).toHaveAttribute('data-nova-state', 'speaking', { timeout: 40_000 })
  await expect(spokenMarkers(page)).toHaveCount(1)
  // The user talks over her: Nova goes back to Listening.
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 30_000 })
  // A new turn begins from what was said over her, and reaches the chat as a second spoken message.
  await expect(spokenMarkers(page)).toHaveCount(2, { timeout: 30_000 })

  const samples = await samplesOf(page)
  const first = samples.findIndex((s) => s.state === 'speaking')
  const cut = samples.findIndex((s, i) => i > first && s.state === 'listening')
  expect(first).toBeGreaterThanOrEqual(0)
  expect(cut, 'Nova went back to Listening').toBeGreaterThan(first)
  // She was cut off: the answer's tone runs about 12 s, and she stopped well before it would have ended.
  expect(samples[cut]!.t - samples[first]!.t).toBeLessThan(9000)
  // The tone was playing until the cut, and is silent within 500 ms of it.
  expect(samples[cut - 1]!.playing).toBeGreaterThan(0)
  const silent = samples.findIndex((s, i) => i >= cut && s.playing === 0)
  expect(silent).toBeGreaterThanOrEqual(0)
  expect(samples[silent]!.t - samples[cut]!.t).toBeLessThan(500)
  await panel.getByRole('button', { name: 'End conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'idle', { timeout: 5000 })
})

test('2.3: a 200 ms blip of speech does not interrupt Nova; she finishes her answer', async () => {
  test.setTimeout(120_000)
  // A 200 ms burst of speech every two seconds (under the 400 ms bar).
  const wav = loopWav('blip', speechSamples(1.41, 1.61), 2)
  const { page, panel, state } = await openNova({ wav })
  await startSampler(page, panel)

  await panel.getByRole('button', { name: 'Start conversation' }).click()
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 15_000 })
  // A typed question gets the long answer; the conversation stays on, so talking over her would count.
  await sendToBrain(page, 'Tell me a lot')
  await expect(state).toHaveAttribute('data-nova-state', 'speaking', { timeout: 30_000 })
  // She speaks to the end, then listens again for the next turn.
  await expect(state).toHaveAttribute('data-nova-state', 'listening', { timeout: 40_000 })

  const samples = await samplesOf(page)
  const start = samples.findIndex((s) => s.state === 'speaking')
  const end = samples.findIndex((s, i) => i > start && s.state !== 'speaking')
  expect(end).toBeGreaterThan(start)
  const seconds = (samples[end]!.t - samples[start]!.t) / 1000
  // Three sentences of about 4 s each. An interrupted answer would stop at the first blip.
  expect(seconds).toBeGreaterThan(10)
  // The loop repeats the blip every two seconds, so five or more went by while she spoke.
  // The tone played right up to the end, and nothing from the blips was sent as a turn.
  expect(samples[end - 1]!.playing).toBeGreaterThan(0)
  await expect(spokenMarkers(page)).toHaveCount(0)
})
