// @spec: 016-voice-companion
// @regression
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, sendToBrain, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

const VERSION = 'stub0001'
const CHUNK = 8 * 1024
const CHUNK_DELAY_MS = 20

interface StubFile {
  path: string
  data: Buffer
}
interface StubModel {
  id: string
  kind: 'tts' | 'stt-stream' | 'stt-final'
  files: StubFile[]
}

/** Deterministic bytes, so every run serves, and hashes, the same files. */
const bytes = (seed: number, length: number): Buffer =>
  Buffer.from(Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff))

const MODELS: StubModel[] = [
  {
    id: 'kokoro',
    kind: 'tts',
    files: [
      { path: 'onnx/model.onnx', data: bytes(1, 300_000) },
      { path: 'config.json', data: bytes(2, 2_000) }
    ]
  },
  {
    id: 'zipformer-en-20m',
    kind: 'stt-stream',
    files: [{ path: 'encoder.onnx', data: bytes(3, 150_000) }]
  },
  {
    id: 'whisper-base-en',
    kind: 'stt-final',
    files: [{ path: 'ggml-base.en.bin', data: bytes(4, 150_000) }]
  }
]
const DROPPED = '/kokoro/onnx/model.onnx'

interface RequestRecord {
  path: string
  range: string | undefined
}

let server: Server | undefined
/** How long the stub waits between chunks, and a file it serves with a changed first byte (a damaged download). */
let chunkDelayMs = CHUNK_DELAY_MS
let damagedPath: string | undefined
let port = 0
let dropped = false
const requests: RequestRecord[] = []
const openSockets = new Set<import('node:net').Socket>()

function serve(req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  const range = req.headers.range
  requests.push({ path, range })
  const file = MODELS.flatMap((m) => m.files.map((f) => ({ url: `/${m.id}/${f.path}`, f }))).find(
    (e) => e.url === path
  )
  if (!file) {
    res.writeHead(404).end()
    return
  }
  const total = file.f.data.length
  const match = range ? /^bytes=(\d+)-$/.exec(range) : null
  const start = match ? Number(match[1]) : 0
  let body = file.f.data.subarray(start)
  if (path === damagedPath) {
    body = Buffer.from(body)
    body[0] = body[0]! ^ 0xff
  }
  if (match) {
    res.writeHead(206, {
      'Content-Length': body.length,
      'Content-Range': `bytes ${start}-${total - 1}/${total}`
    })
  } else {
    res.writeHead(200, { 'Content-Length': body.length })
  }
  // The first plain request for one file loses its connection after about half the bytes.
  const dropAt = !dropped && !match && path === DROPPED ? Math.floor(body.length / 2) : -1
  if (dropAt >= 0) dropped = true
  let sent = 0
  const pump = (): void => {
    if (res.destroyed) return
    if (dropAt >= 0 && sent >= dropAt) {
      res.socket?.destroy()
      return
    }
    if (sent >= body.length) {
      res.end()
      return
    }
    res.write(body.subarray(sent, sent + CHUNK))
    sent += CHUNK
    setTimeout(pump, chunkDelayMs)
  }
  pump()
}

async function startServer(listenPort: number): Promise<void> {
  const s = createServer(serve)
  s.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => openSockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(listenPort, '127.0.0.1', resolve)
  })
  server = s
  port = (s.address() as AddressInfo).port
}

async function stopServer(): Promise<void> {
  const s = server
  server = undefined
  if (!s) return
  for (const socket of openSockets) socket.destroy()
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

let tmp: string | undefined
let rig: Rig | undefined

async function cleanUp(): Promise<void> {
  await rig?.dispose()
  rig = undefined
  await stopServer()
  if (tmp) await rm(tmp, { recursive: true, force: true })
  tmp = undefined
}
test.afterAll(cleanUp)
test.afterEach(cleanUp)

/** Records every aria-valuenow the download progress bar shows, from inside the page. */
async function watchProgress(page: Page): Promise<void> {
  await page.evaluate(() => {
    const seen: number[] = []
    ;(window as unknown as { __seenProgress: number[] }).__seenProgress = seen
    const record = (): void => {
      const bar = document.querySelector('[role="progressbar"]')
      if (bar) seen.push(Number(bar.getAttribute('aria-valuenow')))
    }
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      attributes: true,
      childList: true
    })
  })
}
const seenProgress = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as unknown as { __seenProgress: number[] }).__seenProgress)

test('3.1: voice models download with a resume after a dropped connection, delete, and fail offline with Retry', async () => {
  test.setTimeout(120_000)
  await startServer(0)
  const boundPort = port
  tmp = await mkdtemp(join(tmpdir(), 'arc-voice-e2e-'))
  const manifestPath = join(tmp, 'manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      MODELS.map((m) => ({
        id: m.id,
        kind: m.kind,
        version: VERSION,
        baseUrl: `http://127.0.0.1:${boundPort}/${m.id}`,
        files: m.files.map((f) => ({ path: f.path, sha256: sha(f.data), bytes: f.data.length }))
      }))
    )
  )

  const r = await launchRig({
    scenario: 'nova-panel',
    repos: [{ name: 'api' }],
    env: {
      HARNESS_VOICE_MODEL_MANIFEST: manifestPath,
      HARNESS_VOICE_MODEL_BASE_URL: `http://127.0.0.1:${boundPort}`
    }
  })
  rig = r
  const { page } = r
  const voiceDir = join(r.userDataDir, 'voice-models')
  const row = (id: string): ReturnType<Page['locator']> =>
    page.locator(`[data-voice-model="${id}"]`)

  // The Nova panel offers the same download prompt while the models are missing.
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  await expect(
    page.locator('[data-nova-panel]').getByRole('button', { name: /Download voice models/ })
  ).toBeVisible()

  // Settings > Voice: everything is missing.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Voice' }).click()
  await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible()
  for (const m of MODELS) await expect(row(m.id)).toContainText('Not downloaded')
  const download = page.getByRole('button', { name: /Download voice models/ })
  await expect(download).toBeVisible()

  // Download asks first; Cancel changes nothing.
  await download.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Download voice models?')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(requests).toHaveLength(0)

  // Confirm: progress rises (an intermediate value is seen), the drop is survived, all rows are Ready.
  await watchProgress(page)
  await download.click()
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(page.getByRole('progressbar')).toBeVisible()
  for (const m of MODELS) await expect(row(m.id)).toContainText('Ready', { timeout: 60_000 })
  const seen = await seenProgress(page)
  expect(seen.some((v) => v > 0 && v < 100)).toBe(true)
  const middle = seen.filter((v) => v > 0 && v < 100)
  expect(middle).toEqual([...middle].sort((a, b) => a - b))

  // The server saw the drop and then a resumed request from a non-zero offset.
  expect(dropped).toBe(true)
  const resumes = requests.filter(
    (q) => q.path === DROPPED && q.range && Number(/^bytes=(\d+)-$/.exec(q.range)?.[1]) > 0
  )
  expect(resumes.length).toBeGreaterThanOrEqual(1)

  // On disk: whole model folders, no leftovers.
  const folders = MODELS.map((m) => `${m.id}@${VERSION}`)
  expect(readdirSync(voiceDir).sort()).toEqual([...folders].sort())
  for (const m of MODELS) {
    for (const f of m.files)
      expect(existsSync(join(voiceDir, `${m.id}@${VERSION}`, f.path))).toBe(true)
  }
  expect(readdirSync(voiceDir).filter((n) => n.includes('.partial'))).toEqual([])

  // Delete returns everything to Missing and removes the folders.
  await page.getByRole('button', { name: 'Delete voice models' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  for (const m of MODELS) await expect(row(m.id)).toContainText('Not downloaded')
  expect(readdirSync(voiceDir)).toEqual([])

  // Offline: with the server stopped, Download fails with the offline message and Retry.
  await stopServer()
  await download.click()
  await dialog.getByRole('button', { name: 'Download', exact: true }).click()
  await expect(
    page.getByText("Couldn't download the voice models. Check your connection and try again.")
  ).toBeVisible({ timeout: 30_000 })
  const retry = page.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  // The failed download is over: no stale progress bar or "Downloading" line next to the error.
  await expect(page.getByRole('progressbar')).toHaveCount(0)
  await expect(page.getByText('Downloading voice models')).toHaveCount(0)
  for (const m of MODELS) await expect(row(m.id)).not.toContainText('Ready')

  // The network comes back on the same port: Retry finishes the job.
  await startServer(boundPort)
  await retry.click()
  for (const m of MODELS) await expect(row(m.id)).toContainText('Ready', { timeout: 60_000 })
  await expect(retry).toHaveCount(0)
  expect(readdirSync(voiceDir).sort()).toEqual([...folders].sort())
})

/** The stub models behind a fresh server, with Arc started on a session and no voice files on disk. */
async function startWithStub(options: {
  delayMs: number
  damaged?: string
}): Promise<{ r: Rig; page: Page; voiceDir: string }> {
  chunkDelayMs = options.delayMs
  damagedPath = options.damaged
  dropped = true
  requests.length = 0
  await stopServer()
  await startServer(0)
  tmp = await mkdtemp(join(tmpdir(), 'arc-voice-e2e-'))
  const manifestPath = join(tmp, 'manifest.json')
  await writeFile(
    manifestPath,
    JSON.stringify(
      MODELS.map((m) => ({
        id: m.id,
        kind: m.kind,
        version: VERSION,
        baseUrl: `http://127.0.0.1:${port}/${m.id}`,
        files: m.files.map((f) => ({ path: f.path, sha256: sha(f.data), bytes: f.data.length }))
      }))
    )
  )
  const r = await launchRig({
    // Answers any number of messages with one short line, whatever the timing of the download.
    scenario: 'nova-listen',
    repos: [{ name: 'api' }],
    env: {
      HARNESS_VOICE_MODEL_MANIFEST: manifestPath,
      HARNESS_VOICE_MODEL_BASE_URL: `http://127.0.0.1:${port}`
    }
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(r.page.getByText('Ready.')).toBeVisible({ timeout: 30_000 })
  return { r, page: r.page, voiceDir: join(r.userDataDir, 'voice-models') }
}

async function openVoiceSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Voice' }).click()
  await expect(page.getByRole('heading', { name: 'Voice' })).toBeVisible()
}

const confirmDownload = async (page: Page): Promise<void> => {
  await page.getByRole('dialog').getByRole('button', { name: 'Download', exact: true }).click()
}

test('2.6: the Nova panel shows download progress with a percentage while typing in the chat still works', async () => {
  test.setTimeout(120_000)
  const { page } = await startWithStub({ delayMs: 100 })
  await page.getByRole('button', { name: 'Nova', exact: true }).click()
  const panel = page.locator('[data-nova-panel]')
  await panel.getByRole('button', { name: /^Download voice models/ }).click()
  expect(requests).toHaveLength(0)
  await confirmDownload(page)

  // The bar and the percentage show while the files arrive.
  await expect(panel.getByRole('progressbar')).toBeVisible()
  await expect(panel.getByText(/Downloading voice models\.\.\. \d+%/)).toBeVisible()

  // A message typed now is sent and answered as usual, with the download still running.
  await sendToBrain(page, 'Typed while the download runs')
  await expect(page.getByText('Here is a short answer.').first()).toBeVisible({ timeout: 30_000 })
  await expect(panel.getByRole('progressbar')).toBeVisible()

  // The download then finishes and the prompt goes.
  await expect(panel.locator('[data-voice-models-prompt]')).toHaveCount(0, { timeout: 60_000 })
})

test('2.6: after the connection is lost part way, Retry carries on from where the download stopped', async () => {
  test.setTimeout(120_000)
  const { page } = await startWithStub({ delayMs: 50 })
  await openVoiceSettings(page)
  const download = page.getByRole('button', { name: /Download voice models/ })
  await download.click()
  await confirmDownload(page)
  const bar = page.getByRole('progressbar')
  await expect(bar).toBeVisible()
  await expect
    .poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(10)

  // The Mac goes offline in the middle of a file.
  const boundPort = port
  await stopServer()
  await expect(
    page.getByText("Couldn't download the voice models. Check your connection and try again.")
  ).toBeVisible({ timeout: 60_000 })
  const retry = page.getByRole('button', { name: 'Retry' })
  await expect(retry).toBeVisible()
  const before = requests.length

  // The connection is back: Retry asks for the rest of the file, not the whole of it.
  await startServer(boundPort)
  await retry.click()
  for (const m of MODELS) {
    await expect(page.locator(`[data-voice-model="${m.id}"]`)).toContainText('Ready', {
      timeout: 60_000
    })
  }
  const resumed = requests
    .slice(before)
    .filter((q) => q.range && Number(/^bytes=(\d+)-$/.exec(q.range)?.[1]) > 0)
  expect(resumed.length).toBeGreaterThanOrEqual(1)
})

test('2.6: a damaged voice file shows the damaged-download message, and Try again then succeeds', async () => {
  test.setTimeout(120_000)
  const { page, voiceDir } = await startWithStub({
    delayMs: 5,
    damaged: '/whisper-base-en/ggml-base.en.bin'
  })
  await openVoiceSettings(page)
  await page.getByRole('button', { name: /Download voice models/ }).click()
  await confirmDownload(page)
  await expect(page.getByText("A voice model didn't download correctly. Try again.")).toBeVisible({
    timeout: 60_000
  })
  await expect(page.locator('[data-voice-model="whisper-base-en"]')).not.toContainText('Ready')
  // The damaged model is never installed (only a leftover partial may remain).
  expect(readdirSync(voiceDir)).not.toContain(`whisper-base-en@${VERSION}`)

  damagedPath = undefined
  await page.getByRole('button', { name: 'Retry' }).click()
  for (const m of MODELS) {
    await expect(page.locator(`[data-voice-model="${m.id}"]`)).toContainText('Ready', {
      timeout: 60_000
    })
  }
})
