// @spec: 012-brain-attachments
// @regression
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { messageBox, pasteImage, tinyPng } from './attachments-rig'
import { launchCodexRig, readCodexLog } from './codex-rig'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 012 slice 7: the brain passes an attachment to a worker. The fake Claude brain reads the attachment id from
 * the message it was sent (the `capture` step), calls spawn_worker and message_worker with it, and the worker, a fake
 * Claude or a fake Codex, receives the block and the image. Fake CLIs only.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const PNG = tinyPng()
const TASK = 'Describe the pasted screenshot'
const BAD_ID = '01HZZZZZZZZZZZZZZZZZZZZZZZ'
const loaded = (img: Element): boolean => (img as HTMLImageElement).naturalWidth > 0

type Rec = Record<string, unknown>
interface StdinMessage {
  text: string
  content: Rec[]
}

/** Starts an Autonomous session on the rig, then sends a pasted PNG with a sentence. */
async function sendImage(r: Rig, brainReady: string): Promise<void> {
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(page.getByText(brainReady).first()).toBeVisible({ timeout: 30_000 })
  await pasteImage(page, PNG)
  await expect(page.locator('[data-composer] [data-attachment-chip]')).toHaveCount(1)
  await messageBox(page).fill('Please look at this')
  await page.getByRole('button', { name: 'Send' }).click()
}

/** The session's attachments folder and the one stored image in it (id, path). */
function stored(r: Rig): { dir: string; id: string; path: string } {
  const root = join(r.userDataDir, 'sessions')
  const [sessionId, ...more] = readdirSync(root)
  expect(more).toEqual([])
  const dir = join(root, sessionId!, 'attachments')
  const [id, ...others] = readdirSync(dir)
  expect(others).toEqual([])
  const path = join(dir, id!, 'pasted-image-1.png')
  expect(existsSync(path)).toBe(true)
  return { dir, id: id!, path }
}

/** Every stdin message the fake Claude processes received that mention `needle`, in order. */
function stdinWith(r: Rig, needle: string): StdinMessage[] {
  return readFakeLog(r).flatMap((l) => {
    const m = (l['stdin'] as { message?: { content?: Rec[] } } | undefined)?.message
    const content = m?.content
    if (!Array.isArray(content)) return []
    const text = content
      .filter((b) => b['type'] === 'text')
      .map((b) => String(b['text']))
      .join('\n')
    return text.includes(needle) ? [{ text, content }] : []
  })
}

function toolResults(r: Rig, tool: string): { isError: boolean; text: string }[] {
  return readFakeLog(r).flatMap((l) => {
    const res = l['mcpResult'] as { tool?: string; isError: boolean; text: string } | undefined
    return res?.tool === tool ? [{ isError: res.isError, text: res.text }] : []
  })
}

/** Opens the details of the worker card and returns the Attachments list in them. */
async function openAttachments(page: Page, title: string): Promise<Locator> {
  await workerCard(page, title)
    .getByRole('button', { name: /^Details for/ })
    .click()
  const details = page.locator('[data-worker-details]')
  await expect(details).toBeVisible()
  await expect(details).toContainText(TASK)
  return details.locator('[data-worker-attachments]')
}

async function expectThumbAndPreview(list: Locator, page: Page): Promise<void> {
  await expect(list.locator('h4')).toHaveText('Attachments')
  const chips = list.locator('[data-attachment-chip]')
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toContainText('Pasted image 1')
  const thumb = list.locator('img[data-attachment-thumb]')
  await expect(thumb).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)

  await chips.first().click()
  const preview = page.getByRole('dialog', { name: 'Pasted image 1' })
  await expect(preview).toBeVisible()
  const full = preview.locator('img[data-image-preview]')
  await expect(full).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => full.evaluate(loaded)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
}

test('Claude worker: the brain passes the image to spawn_worker; the worker is told the path, gets the image, and its task lists it', async () => {
  rig = await launchRig({ scenario: 'att-worker', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await sendImage(r, 'Ready.')

  const card = workerCard(page, 'W1 · look')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-worker-card]')).toHaveCount(1)
  await expect(page.getByText('The worker is looking.')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => stdinWith(r, TASK).length, { timeout: 30_000 }).toBeGreaterThan(0)

  const list = await openAttachments(page, 'W1 · look')
  await expectThumbAndPreview(list, page)

  // The worker's own input: the task, the block with the id and stored path, and the image bytes.
  const { dir, id, path } = stored(r)
  const first = stdinWith(r, TASK).find((m) => m.text.includes('[Attachments for this message]'))
  expect(first, 'the worker first message').toBeTruthy()
  expect(first!.text).toContain(id)
  expect(first!.text).toContain(path)
  expect(first!.text).toContain('Pasted image 1')
  const image = first!.content.find((b) => b['type'] === 'image') as
    { source?: { type?: string; media_type?: string; data?: string } } | undefined
  expect(image?.source?.media_type).toBe('image/png')
  expect(Buffer.from(image!.source!.data!, 'base64').equals(PNG)).toBe(true)

  // The worker was launched with the session's attachments folder.
  const argv = readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is string[] => Array.isArray(a) && a.some((x) => x.includes('[arc-role:worker]'))
    )
  expect(argv).toHaveLength(1)
  const addDirs = argv[0]!.flatMap((a, i) => (a === '--add-dir' ? [argv[0]![i + 1]] : []))
  expect(addDirs).toContain(dir)

  // The brain's tool call succeeded.
  const results = toolResults(r, 'spawn_worker')
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(false)
})

test('Claude worker: message_worker with the id gives the running worker a second block, and its task lists the image once', async () => {
  rig = await launchRig({ scenario: 'att-worker', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await sendImage(r, 'Ready.')
  await expect(workerCard(page, 'W1 · look')).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => stdinWith(r, TASK).length, { timeout: 30_000 }).toBeGreaterThan(0)

  await messageBox(page).fill('Ask again')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Asked again.')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => stdinWith(r, 'Second look at it').length, { timeout: 30_000 })
    .toBeGreaterThan(0)

  const { id, path } = stored(r)
  const second = stdinWith(r, 'Second look at it')
  // The worker's copy of the message: the text, the block, and the image, after the brain's own tool call.
  const received = second.find((m) => m.text.includes('[Attachments for this message]'))
  expect(received, 'the worker second message').toBeTruthy()
  expect(received!.text).toContain(id)
  expect(received!.text).toContain(path)
  expect(received!.content.some((b) => b['type'] === 'image')).toBe(true)
  const results = toolResults(r, 'message_worker')
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(false)

  const list = await openAttachments(page, 'W1 · look')
  await expect(list.locator('[data-attachment-chip]')).toHaveCount(1)
})

test('Unknown id: spawn_worker refuses with unknown_attachment, naming the bad id and listing the valid one; no worker starts', async () => {
  rig = await launchRig({ scenario: 'att-worker-unknown', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await sendImage(r, 'Ready.')
  await expect(page.getByText('The tool refused.')).toBeVisible({ timeout: 30_000 })

  const results = toolResults(r, 'spawn_worker')
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(true)
  const { id } = stored(r)
  const refusal = JSON.parse(results[0]!.text) as { error: string; message: string }
  expect(refusal.error).toBe('unknown_attachment')
  expect(refusal.message).toContain(`"${BAD_ID}"`)
  expect(refusal.message).toContain(`${id} (Pasted image 1)`)

  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
  // No worker process was started either.
  expect(
    readFakeLog(r).filter(
      (l) => Array.isArray(l['argv']) && JSON.stringify(l['argv']).includes('[arc-role:worker]')
    )
  ).toHaveLength(0)
})

test('Codex worker: the brain passes the image; turn/start holds the text block and a localImage with the stored path, and the task lists it', async () => {
  const c = await launchCodexRig({
    scenario: 'att-worker-codex',
    codexScenario: 'att-worker-codex',
    repos: [{ name: 'api' }]
  })
  rig = c
  const { page } = c
  await sendImage(c, 'Ready.')
  const card = workerCard(page, 'W1 · look')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card.locator('[data-worker-model]')).toContainText('Codex')
  await expect
    .poll(() => readCodexLog(c).some((l) => JSON.stringify(l).includes('turn/start')), {
      timeout: 30_000
    })
    .toBe(true)

  const { dir, id, path } = stored(c)
  const input = readCodexLog(c).flatMap((l) => {
    const recv = l['recv'] as { method?: string; params?: { input?: Rec[] } } | undefined
    return recv?.method === 'turn/start' ? [recv.params?.input ?? []] : []
  })
  // The first turn carries the attachments; a later one is Arc's reminder to report done.
  expect(input.length).toBeGreaterThan(0)
  expect(input[0]!.map((item) => item['type'])).toEqual(['text', 'localImage'])
  const text = String(input[0]![0]!['text'])
  expect(text).toContain('[Attachments for this message]')
  expect(text).toContain(id)
  expect(text).toContain(path)
  expect(input[0]![1]).toEqual({ type: 'localImage', path })
  expect(readFileSync(path).equals(PNG)).toBe(true)
  expect(path.startsWith(dir)).toBe(true)

  const results = toolResults(c, 'spawn_worker')
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(false)

  const list = await openAttachments(page, 'W1 · look')
  await expectThumbAndPreview(list, page)
})
