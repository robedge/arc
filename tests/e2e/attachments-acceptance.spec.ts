// @spec: 012-brain-attachments
// @regression
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  composerChips,
  messageBox,
  queuePicker,
  sentMessages,
  tinyPdf,
  tinyPng,
  underBox
} from './attachments-rig'
import { createGroupWithProjects, launchRig, readFakeLog, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 012 acceptance cases for the criteria the slice specs proved only with synthetic events, a stubbed
 * browser default, or not at all. The cases are named by criterion: section number, then position in the
 * functional spec. The brain is the fake Claude CLI and nothing outside the temporary HOME is touched.
 *
 * Two of the helpers are closer to the real thing than the slice specs were:
 *  - paste goes through the system clipboard and the keyboard shortcut, so the browser's own paste runs;
 *  - a drag is a Chromium drag event carrying real file paths (`Input.dispatchDragEvent`), which is what the
 *    OS hands the window when files are dragged in from Finder.
 * The system clipboard's text is put back after each case.
 */

let rig: Rig | undefined
let scratch: string | undefined
let savedClipboard: string | undefined
test.afterEach(async () => {
  if (rig && savedClipboard !== undefined) {
    const text = savedClipboard
    await rig.app
      .evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
      .catch(() => undefined)
  }
  savedClipboard = undefined
  await rig?.dispose()
  rig = undefined
  if (scratch) {
    // A case may have made a file unreadable on purpose.
    for (const name of readdirSync(scratch)) chmodSync(join(scratch, name), 0o700)
    rmSync(scratch, { recursive: true, force: true })
  }
  scratch = undefined
})

const TEXT = 'Build notes\nThe nightly build takes four minutes.\n'
const loaded = (img: Element): boolean => (img as HTMLImageElement).naturalWidth > 0
const noticeLines = (page: Page) => page.locator('[data-attachment-notices] [data-notice-text]')
const pasteKey = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'

function makeScratch(): string {
  scratch = mkdtempSync(join(tmpdir(), 'arc-acc-'))
  return scratch
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
    )
  return walk(root, '')
}

const stdinTexts = (r: Rig): string[] =>
  readFakeLog(r)
    .map((l) => l['stdin'] as { message?: { content?: { text?: string }[] } } | undefined)
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => s.message?.content?.[0]?.text ?? '')
    .filter((t) => t !== '')

async function openSession(r: Rig): Promise<void> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(r.page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
}

/** Remembers the system clipboard's text, then puts `text` on it. */
async function clipboardText(r: Rig, text: string): Promise<void> {
  if (savedClipboard === undefined) {
    savedClipboard = await r.app.evaluate(({ clipboard }) => clipboard.readText())
  }
  await r.app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text)
}

/** Puts a PNG on the system clipboard the way a screenshot tool does. */
async function clipboardImage(r: Rig, png: Buffer): Promise<void> {
  if (savedClipboard === undefined) {
    savedClipboard = await r.app.evaluate(({ clipboard }) => clipboard.readText())
  }
  await r.page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([bin], { type: 'image/png' }) })
    ])
  }, png.toString('base64'))
}

/** A drag from outside the app, with real paths, over the middle of `target`. */
async function osDrag(
  page: Page,
  type: 'dragEnter' | 'dragOver' | 'drop',
  target: string,
  paths: string[]
): Promise<void> {
  const box = await page.locator(target).boundingBox()
  expect(box, `${target} is on screen`).not.toBeNull()
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Input.dispatchDragEvent', {
      type,
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
      data: { items: [], files: paths, dragOperationsMask: 1 }
    } as never)
  } finally {
    await cdp.detach()
  }
}

async function dropFromOutside(page: Page, paths: string[]): Promise<void> {
  await osDrag(page, 'dragEnter', '#composer-input', paths)
  await osDrag(page, 'dragOver', '#composer-input', paths)
  await expect(page.locator('[data-drop-label]')).toHaveText('Drop to attach')
  await osDrag(page, 'drop', '#composer-input', paths)
  await expect(page.locator('[data-drop-label]')).toHaveCount(0)
}

async function openNewSession(r: Rig): Promise<void> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await r.page.getByRole('button', { name: 'New Session' }).click()
  await r.page.getByRole('dialog').getByLabel('Autonomous', { exact: false }).check()
}

test('2.1-1 + 2.1-2: a screenshot on the system clipboard, pasted with the keyboard, attaches in the new session screen and in an open session, and inserts no text', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openNewSession(r)
  const dialog = page.getByRole('dialog')

  await clipboardImage(r, tinyPng())
  await page.locator('#new-session-request').focus()
  await page.keyboard.press(pasteKey)
  const chip = dialog.locator('[data-attachment-chip]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('Pasted image 1')
  await expect(chip.locator('img[data-attachment-thumb]')).toHaveAttribute(
    'src',
    /^arc-attachment:\/\/staged\//
  )
  await expect(dialog.getByLabel('Request')).toHaveValue('')

  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })

  await messageBox(page).focus()
  await page.keyboard.press(pasteKey)
  const waiting = composerChips(page)
  await expect(waiting).toHaveCount(1)
  await expect(waiting).toContainText('Pasted image 1')
  const thumb = waiting.locator('img[data-attachment-thumb]')
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)
  await expect(messageBox(page)).toHaveValue('')
})

test('2.1-3: text on the system clipboard, pasted with the keyboard, is inserted as text and adds no attachment', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openNewSession(r)
  const dialog = page.getByRole('dialog')
  const words = 'The nightly build takes four minutes.'

  await clipboardText(r, words)
  await page.locator('#new-session-request').focus()
  await page.keyboard.press(pasteKey)
  await expect(dialog.getByLabel('Request')).toHaveValue(words)
  await expect(dialog.locator('[data-attachment-chip]')).toHaveCount(0)

  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })

  await messageBox(page).focus()
  await page.keyboard.press(pasteKey)
  await expect(messageBox(page)).toHaveValue(words)
  await expect(composerChips(page)).toHaveCount(0)
  await expect(underBox(page)).toHaveCount(0)
})

test('2.1-6: two images without file names pasted into one message are listed as "Pasted image 1" and "Pasted image 2"', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await clipboardImage(r, tinyPng())
  await messageBox(page).focus()
  await page.keyboard.press(pasteKey)
  await expect(composerChips(page)).toHaveCount(1)
  await page.keyboard.press(pasteKey)
  await expect(composerChips(page)).toHaveCount(2)
  await expect(page.locator('[data-composer] [data-attachment-name]')).toHaveText([
    'Pasted image 1',
    'Pasted image 2'
  ])

  await page.getByRole('button', { name: 'Send' }).click()
  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(message).toContainText('Pasted image 1')
  await expect(message).toContainText('Pasted image 2')
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })
  const sentText = stdinTexts(r).find((t) => t.includes('[Attachments for this message]'))
  expect(sentText).toContain('Pasted image 1')
  expect(sentText).toContain('Pasted image 2')
})

test('2.1-4: two files dragged in from outside the app show "Drop to attach" over the message box, and both attach when dropped', async () => {
  const dir = makeScratch()
  const text = join(dir, 'build-notes.txt')
  const pdf = join(dir, 'layout-sheet.pdf')
  writeFileSync(text, TEXT)
  writeFileSync(pdf, tinyPdf())
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await dropFromOutside(page, [text, pdf])
  await expect(composerChips(page)).toHaveCount(2)
  await expect(underBox(page)).toContainText('build-notes.txt')
  await expect(underBox(page)).toContainText('layout-sheet.pdf')
  await expect(noticeLines(page)).toHaveCount(0)
})

test('2.2-1: a PNG, a PDF and a log file all appear as attachments', async () => {
  const dir = makeScratch()
  const png = join(dir, 'site-capture.png')
  const pdf = join(dir, 'layout-sheet.pdf')
  const log = join(dir, 'server.log')
  writeFileSync(png, tinyPng())
  writeFileSync(pdf, tinyPdf())
  writeFileSync(
    log,
    '2026-11-12 10:00:01 INFO listening on 3000\n2026-11-12 10:00:09 WARN slow query\n'
  )
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await queuePicker(r, [png, pdf, log])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(underBox(page).getByRole('listitem')).toHaveCount(3)
  await expect(underBox(page)).toContainText('site-capture.png')
  await expect(underBox(page)).toContainText('layout-sheet.pdf')
  await expect(underBox(page)).toContainText('server.log')
  await expect(noticeLines(page)).toHaveCount(0)
})

test('2.2-5 + 2.2-7: dropping a folder attaches nothing and says so; dropping an allowed file with a ZIP attaches the file and names only the ZIP', async () => {
  const dir = makeScratch()
  const folder = join(dir, 'sample-folder')
  mkdirSync(folder)
  const text = join(dir, 'build-notes.txt')
  writeFileSync(text, TEXT)
  // A 22-byte empty ZIP (end-of-central-directory record only).
  const zip = join(dir, 'release-bundle.zip')
  writeFileSync(zip, Buffer.concat([Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(18)]))
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await dropFromOutside(page, [folder])
  await expect(noticeLines(page)).toHaveText(["Folders can't be attached."])
  await expect(composerChips(page)).toHaveCount(0)

  await dropFromOutside(page, [text, zip])
  await expect(composerChips(page)).toHaveCount(1)
  await expect(underBox(page)).toContainText('build-notes.txt')
  await expect(noticeLines(page)).toHaveText([
    "release-bundle.zip can't be attached. Arc accepts images, PDFs and text files."
  ])
})

test('2.2-6: a file that cannot be opened is not attached and the user sees "[name] couldn\'t be read."', async () => {
  const dir = makeScratch()
  const locked = join(dir, 'private-notes.txt')
  writeFileSync(locked, TEXT)
  chmodSync(locked, 0o000)
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await queuePicker(r, [locked])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(noticeLines(page)).toHaveText(["private-notes.txt couldn't be read."])
  await expect(composerChips(page)).toHaveCount(0)
  expect(filesUnder(join(r.userDataDir, 'attachment-staging'))).toEqual([])
})

test('2.4-8: when Arc\'s copy of an attachment can no longer be read, Send does not send and says "[name] could no longer be read. Remove it or attach it again."', async () => {
  const dir = makeScratch()
  const text = join(dir, 'build-notes.txt')
  writeFileSync(text, TEXT)
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)
  const messagesBefore = await sentMessages(page).count()
  const stdinBefore = stdinTexts(r).length

  await queuePicker(r, [text])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(composerChips(page)).toHaveCount(1)

  // Arc's copy is the one under the staging folder; the original is not involved.
  const staging = join(r.userDataDir, 'attachment-staging')
  const copies = filesUnder(staging)
  expect(copies).toHaveLength(1)
  rmSync(join(staging, copies[0]!))

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(
    page.getByText('build-notes.txt could no longer be read. Remove it or attach it again.')
  ).toBeVisible()
  await expect(sentMessages(page)).toHaveCount(messagesBefore)
  expect(stdinTexts(r).length).toBe(stdinBefore)
  // Nothing was written for the session, and the attachment is still listed so the user can remove it.
  await expect(composerChips(page)).toHaveCount(1)
  await expect(page.locator('[data-composer]')).toContainText('build-notes.txt')

  await page.getByRole('button', { name: 'Remove build-notes.txt' }).click()
  await expect(composerChips(page)).toHaveCount(0)
})
