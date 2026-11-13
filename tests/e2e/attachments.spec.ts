// @spec: 012-brain-attachments
// @regression
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  composerChips,
  messageBox,
  pasteImage,
  queuePicker,
  sentMessages,
  tinyPdf,
  tinyPng,
  underBox
} from './attachments-rig'
import { createGroupWithProjects, launchRig, readFakeLog, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 012 slice 2: attach files with the picker, see them under the box and on the sent message, and find them in
 * what the fake Claude brain received. Fake CLIs only.
 */

let rig: Rig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const TEXT = 'Build notes\nThe nightly build takes four minutes.\n'

interface Files {
  text: string
  pdf: string
}

function makeFiles(): Files {
  scratch = mkdtempSync(join(tmpdir(), 'arc-att-'))
  const text = join(scratch, 'build-notes.txt')
  const pdf = join(scratch, 'layout-sheet.pdf')
  writeFileSync(text, TEXT)
  writeFileSync(pdf, tinyPdf())
  return { text, pdf }
}

const bytes = (path: string): string => `${statSync(path).size} B`

/** Every file under `root`, as relative paths. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
    )
  return walk(root, '')
}

function sessionIds(r: Rig): string[] {
  const root = join(r.userDataDir, 'sessions')
  return existsSync(root) ? readdirSync(root) : []
}

async function openSession(r: Rig): Promise<void> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(r.page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
}

test('2.1 + 2.3 + 2.4: pick two files, remove one, send with no text; the message, the brain and the disk hold the file', async () => {
  const files = makeFiles()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await queuePicker(r, [files.text, files.pdf])
  await page.getByRole('button', { name: 'Attach files' }).click()
  const row = underBox(page)
  await expect(row.getByRole('listitem')).toHaveCount(2)
  await expect(row).toContainText('build-notes.txt')
  await expect(row).toContainText(bytes(files.text))
  await expect(row).toContainText('layout-sheet.pdf')
  await expect(row).toContainText(bytes(files.pdf))

  await page.getByRole('button', { name: 'Remove layout-sheet.pdf' }).click()
  await expect(row.getByRole('listitem')).toHaveCount(1)
  await expect(row).not.toContainText('layout-sheet.pdf')

  // Arc took its own copy: the original can go before Send (spec 2.4).
  rmSync(files.text)
  await expect(page.getByLabel('Message to the brain')).toHaveValue('')
  const send = page.getByRole('button', { name: 'Send' })
  await expect(send).toBeEnabled()
  await send.click()

  // The message shows the attachment and the row under the box is empty.
  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(1)
  await expect(message).toContainText('build-notes.txt')
  await expect(message).toContainText(`${TEXT.length} B`)
  await expect(page.locator('[data-composer] [data-attachment-chip]')).toHaveCount(0)
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })

  // The brain received the block with the stored path, and the folder is in its argv.
  const [sessionId] = sessionIds(r)
  expect(sessionId).toBeTruthy()
  const attachmentsDir = join(r.userDataDir, 'sessions', sessionId!, 'attachments')
  const stdin = readFakeLog(r)
    .map((l) => l['stdin'] as { message?: { content?: { text?: string }[] } } | undefined)
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => s.message?.content?.[0]?.text ?? '')
  const sentText = stdin.find((t) => t.includes('[Attachments for this message]'))
  expect(sentText).toBeTruthy()
  const stored = filesUnder(attachmentsDir)
  expect(stored).toHaveLength(1)
  const [attachmentId, storedName] = stored[0]!.split('/')
  const storedPath = join(attachmentsDir, attachmentId!, storedName!)
  expect(sentText).toContain(attachmentId!)
  expect(sentText).toContain('build-notes.txt')
  expect(sentText).toContain(storedPath)
  expect(readFileSync(storedPath, 'utf8')).toBe(TEXT)

  const argv = readFakeLog(r)
    .map((l) => l['argv'])
    .filter((a): a is string[] => Array.isArray(a) && a.some((x) => x.includes('[arc-role:brain]')))
  expect(argv).toHaveLength(1)
  const addDirs = argv[0]!.flatMap((a, i) => (a === '--add-dir' ? [argv[0]![i + 1]] : []))
  expect(addDirs).toContain(attachmentsDir)

  // Nothing is left in the staging folder.
  expect(filesUnder(join(r.userDataDir, 'attachment-staging'))).toEqual([])
})

test('2.3: an attachment waiting in one session is still listed after visiting another', async () => {
  const files = makeFiles()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await queuePicker(r, [files.text])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(underBox(page).getByRole('listitem')).toHaveCount(1)

  // A second session shows no attachments of the first.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('button', { name: 'New Session', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Request').fill('Another check')
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
  await expect(page.locator('[data-composer] [data-attachment-chip]')).toHaveCount(0)

  // Back in the first one it is still there, and sends.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  const rows = page.locator('[data-session-row]')
  await expect(rows).toHaveCount(2)
  // Newest first: the first session is the second row.
  await rows.nth(1).click()
  await expect(page.locator('[data-composer] [data-attachment-chip]')).toHaveCount(1)
  await expect(page.locator('[data-composer]')).toContainText('build-notes.txt')

  await page.getByRole('button', { name: 'Send' }).click()
  await expect(sentMessages(page).last()).toContainText('build-notes.txt')
  await expect(page.locator('[data-composer] [data-attachment-chip]')).toHaveCount(0)
})

// Slice 3: paste, drop, thumbnails, the full-size preview.

/** Console messages and page errors of the whole test, for the CSP assertion. */
function watchConsole(page: Page): string[] {
  const seen: string[] = []
  page.on('console', (m) => seen.push(`console.${m.type()}: ${m.text()}`))
  page.on('pageerror', (e) => seen.push(`pageerror: ${e.message}`))
  return seen
}

function expectNoCspError(seen: string[]): void {
  expect(seen.filter((m) => /content security policy|arc-attachment/i.test(m))).toEqual([])
}

/**
 * Files with real paths, the way a drop from Finder has them. The page cannot make such a File itself
 * (`getPathForFile` of a made-up File is empty), so a hidden file input takes them from disk, which gives
 * Files backed by the paths. The drag is held over the box so the caller can look at the overlay.
 */
async function dragOver(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.id = '__e2e_drop_source'
    document.body.appendChild(input)
  })
  await page.locator('#__e2e_drop_source').setInputFiles(paths)
  await page.evaluate(() => {
    const input = document.getElementById('__e2e_drop_source') as HTMLInputElement
    const dt = new DataTransfer()
    for (const file of Array.from(input.files ?? [])) dt.items.add(file)
    ;(window as unknown as { __e2eDt: DataTransfer }).__e2eDt = dt
    const box = document.getElementById('composer-input')!
    for (const type of ['dragenter', 'dragover']) {
      box.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    }
  })
}

async function dropHeld(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dt = (window as unknown as { __e2eDt: DataTransfer }).__e2eDt
    const box = document.getElementById('composer-input')!
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    document.getElementById('__e2e_drop_source')?.remove()
  })
}

const loaded = (img: Element): boolean => (img as HTMLImageElement).naturalWidth > 0

test('3.1: a pasted image becomes "Pasted image 1" with a thumbnail through arc-attachment://, and no text is pasted', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  const seen = watchConsole(page)
  await openSession(r)

  await pasteImage(page, tinyPng())

  const chip = composerChips(page)
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('Pasted image 1')
  const thumb = chip.locator('img[data-attachment-thumb]')
  await expect(thumb).toHaveAttribute('src', /^arc-attachment:\/\/staged\//)
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)
  await expect(messageBox(page)).toHaveValue('')
  expectNoCspError(seen)
})

test('3.2 to 3.4: drop two files, paste an image, use the keyboard on the row and the preview, send', async () => {
  const files = makeFiles()
  const png = tinyPng()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  const seen = watchConsole(page)
  await openSession(r)
  await messageBox(page).fill('Look at these')

  // Dropping: the overlay shows while the drag is over the box, then both files are attached.
  await dragOver(page, [files.text, files.pdf])
  await expect(page.locator('[data-drop-label]')).toHaveText('Drop to attach')
  await dropHeld(page)
  await expect(page.locator('[data-drop-label]')).toHaveCount(0)
  await expect(composerChips(page)).toHaveCount(2)
  await expect(underBox(page)).toContainText('build-notes.txt')
  await expect(underBox(page)).toContainText('layout-sheet.pdf')

  await pasteImage(page, png)
  await expect(composerChips(page)).toHaveCount(3)
  await expect(messageBox(page)).toHaveValue('Look at these')

  // Keyboard: the toolbar's roving stop is the first chip; arrows reach the image; Enter opens it.
  const toolbar = page.getByRole('toolbar', { name: 'Attachments' })
  const chips = toolbar.locator('[data-attachment-chip]')
  await chips.first().focus()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  const imageChip = chips.nth(2)
  await expect(imageChip).toBeFocused()
  await expect(imageChip).toHaveAttribute('aria-label', 'Pasted image 1')
  await page.keyboard.press('Enter')
  const preview = page.getByRole('dialog', { name: 'Pasted image 1' })
  await expect(preview).toBeVisible()
  const full = preview.locator('img[data-image-preview]')
  await expect(full).toHaveAttribute('src', /^arc-attachment:\/\/staged\/[^/?]+$/)
  await expect.poll(() => full.evaluate(loaded)).toBe(true)

  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)
  await expect(imageChip).toBeFocused()
  await expect(composerChips(page)).toHaveCount(3)
  await expect(messageBox(page)).toHaveValue('Look at these')

  // Delete on a file chip removes it.
  await page.keyboard.press('ArrowLeft')
  await expect(chips.nth(1)).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(composerChips(page)).toHaveCount(2)
  await expect(underBox(page)).not.toContainText('layout-sheet.pdf')

  // Send: the message shows the image as a thumbnail and the file by name.
  await page.getByRole('button', { name: 'Send' }).click()
  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(message).toContainText('build-notes.txt')
  const sentThumb = message.locator('img[data-attachment-thumb]')
  await expect(sentThumb).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => sentThumb.evaluate(loaded)).toBe(true)
  await expect(composerChips(page)).toHaveCount(0)
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })

  const sentText = readFakeLog(r)
    .map((l) => l['stdin'] as { message?: { content?: { text?: string }[] } } | undefined)
    .map((s) => s?.message?.content?.[0]?.text ?? '')
    .find((t) => t.includes('[Attachments for this message]'))
  expect(sentText).toBeTruthy()
  expect(sentText).toContain('build-notes.txt')
  expect(sentText).toContain('Pasted image 1')
  expect(sentText).not.toContain('layout-sheet.pdf')

  // The sent image opens at full size and Escape closes it.
  await message.getByRole('button', { name: 'Preview Pasted image 1' }).click()
  const sentPreview = page.getByRole('dialog', { name: 'Pasted image 1' })
  const sentFull = sentPreview.locator('img[data-image-preview]')
  await expect(sentFull).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => sentFull.evaluate(loaded)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(sentPreview).toHaveCount(0)
  expectNoCspError(seen)
})

// Slice 4: refusals and limits.

const notices = (page: Page) =>
  page.getByRole('status').filter({ has: page.locator('[data-notice-line]') })
const noticeLines = (page: Page) => page.locator('[data-attachment-notices] [data-notice-text]')

test('2.2: a ZIP, an oversized file, a folder and an eleventh file are refused with their messages while the allowed files stay', async () => {
  const files = makeFiles()
  const dir = scratch!
  // A 22-byte empty ZIP (end-of-central-directory record only).
  const zip = join(dir, 'release-bundle.zip')
  writeFileSync(zip, Buffer.concat([Buffer.from('PK\x05\x06', 'binary'), Buffer.alloc(18)]))
  // Sparse, just over the 20 MB limit; removed with the scratch folder after the test.
  const big = join(dir, 'big-capture.png')
  writeFileSync(big, '')
  truncateSync(big, 20 * 1024 * 1024 + 1)
  const folder = join(dir, 'sample-folder')
  mkdirSync(folder)
  const extras = Array.from({ length: 10 }, (_, i) => {
    const p = join(dir, `note-${String(i + 1).padStart(2, '0')}.txt`)
    writeFileSync(p, `Note ${i + 1}\n`)
    return p
  })

  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)
  const attach = page.getByRole('button', { name: 'Attach files' })
  const listed = underBox(page).getByRole('listitem')

  // 1. One allowed file with a ZIP: the text file is kept and only the ZIP is named.
  await queuePicker(r, [files.text, zip])
  await attach.click()
  await expect(listed).toHaveCount(1)
  await expect(underBox(page)).toContainText('build-notes.txt')
  await expect(noticeLines(page)).toHaveText([
    "release-bundle.zip can't be attached. Arc accepts images, PDFs and text files."
  ])

  // 2. The oversized file is refused; nothing new is listed.
  await queuePicker(r, [big])
  await attach.click()
  await expect(noticeLines(page)).toHaveText(['big-capture.png is too large. The limit is 20 MB.'])
  await expect(listed).toHaveCount(1)

  // 3. A folder.
  await queuePicker(r, [folder])
  await attach.click()
  await expect(noticeLines(page)).toHaveText(["Folders can't be attached."])
  await expect(listed).toHaveCount(1)

  // 5. The region is a status element, and dismissing a line removes it.
  await expect(notices(page)).toHaveCount(1)
  await page.getByRole('button', { name: 'Dismiss: sample-folder' }).click()
  await expect(noticeLines(page)).toHaveCount(0)

  // 4. Nine more reach ten; the next one is refused and ten stay listed.
  await queuePicker(r, extras.slice(0, 9))
  await attach.click()
  await expect(listed).toHaveCount(10)
  await expect(noticeLines(page)).toHaveCount(0)
  await queuePicker(r, [extras[9]!])
  await attach.click()
  await expect(noticeLines(page)).toHaveText(['A message can have at most 10 attachments.'])
  await expect(listed).toHaveCount(10)

  // 6. Send: the message shows the ten and the notice is gone.
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(sentMessages(page).last().locator('[data-attachment-chip]')).toHaveCount(10)
  await expect(composerChips(page)).toHaveCount(0)
  await expect(noticeLines(page)).toHaveCount(0)
})

// Slice 5: first message, cancel, and the two refusals.

const STAGING = (r: Rig): string => join(r.userDataDir, 'attachment-staging')
const stdinTexts = (r: Rig): string[] =>
  readFakeLog(r)
    .map((l) => l['stdin'] as { message?: { content?: { text?: string }[] } } | undefined)
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => s.message?.content?.[0]?.text ?? '')
    .filter((t) => t !== '')

async function pasteInto(page: Page, id: string, png: Buffer): Promise<void> {
  await page.locator(`#${id}`).focus()
  await page.evaluate(
    ([target, data]) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(data as number[])], 'image.png', { type: 'image/png' }))
      document
        .getElementById(target as string)!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        )
    },
    [id, Array.from(png)] as const
  )
}

test('2.1: a session started with a pasted image and no text shows it on the first message and sends it to the brain', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await pasteInto(page, 'new-session-request', tinyPng())
  const chip = dialog.locator('[data-attachment-chip]')
  await expect(chip).toHaveCount(1)
  await expect(chip).toContainText('Pasted image 1')
  await expect(dialog.getByLabel('Request')).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Start' })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Start' }).click()

  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
  // The first user message: the thumbnail from the sent store and no text.
  const first = sentMessages(page).first()
  const thumb = first.locator('img[data-attachment-thumb]')
  await expect(thumb).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)
  await expect(first).toContainText('Pasted image 1')
  expect(
    ((await first.innerText()) ?? '').replace('Pasted image 1', '').replace(/\d+ B/, '').trim()
  ).toBe('')
  // The brain named the session from its reply.
  await expect(page.locator('[data-session-name]')).toHaveText('Attachment check')

  const [sessionId] = sessionIds(r)
  const attachmentsDir = join(r.userDataDir, 'sessions', sessionId!, 'attachments')
  const firstStdin = stdinTexts(r)[0]!
  expect(firstStdin.startsWith('[Attachments for this message]')).toBe(true)
  expect(firstStdin).toContain('Pasted image 1')
  // An image is stored with a thumbnail beside it; the brain is told the original's path.
  const stored = filesUnder(attachmentsDir)
  expect(stored.map((f) => f.split('/')[1]).sort()).toEqual(['pasted-image-1.png', 'thumb.png'])
  const original = stored.find((f) => f.endsWith('/pasted-image-1.png'))!
  expect(firstStdin).toContain(join(attachmentsDir, original))
  expect(existsSync(join(attachmentsDir, original))).toBe(true)
  expect(filesUnder(STAGING(r))).toEqual([])
})

test('2.1: cancelling the dialog, with the button or Escape, drops the attachment and empties the staging folder', async () => {
  const files = makeFiles()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const dialog = page.getByRole('dialog')

  for (const close of ['button', 'escape'] as const) {
    await page.getByRole('button', { name: 'New Session' }).click()
    await expect(dialog.locator('[data-attachment-chip]')).toHaveCount(0)
    await queuePicker(r, [files.text])
    await dialog.getByRole('button', { name: 'Attach files' }).click()
    await expect(dialog.locator('[data-attachment-chip]')).toHaveCount(1)
    await expect(dialog).toContainText('build-notes.txt')
    expect(filesUnder(STAGING(r)).length).toBeGreaterThan(0)
    if (close === 'button') await dialog.getByRole('button', { name: 'Cancel' }).click()
    else await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect.poll(() => filesUnder(STAGING(r))).toEqual([])
  }
  await page.getByRole('button', { name: 'New Session' }).click()
  await expect(dialog.locator('[data-attachment-chip]')).toHaveCount(0)
})

test('2.3: "/review" with an attachment is refused with the box unchanged; an ordinary sentence then sends it', async () => {
  const files = makeFiles()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)
  const stdinBefore = stdinTexts(r).length
  const messagesBefore = await sentMessages(page).count()

  await queuePicker(r, [files.text])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(composerChips(page)).toHaveCount(1)
  await messageBox(page).fill('/review')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText("Attachments can't be sent with a command.")).toBeVisible()
  await expect(messageBox(page)).toHaveValue('/review')
  await expect(composerChips(page)).toHaveCount(1)
  await expect(page.locator('[data-composer]')).toContainText('build-notes.txt')
  await expect(sentMessages(page)).toHaveCount(messagesBefore)
  expect(stdinTexts(r).length).toBe(stdinBefore)

  await messageBox(page).fill('Please read the notes')
  await expect(page.getByText("Attachments can't be sent with a command.")).toHaveCount(0)
  await page.getByRole('button', { name: 'Send' }).click()
  const message = sentMessages(page).last()
  await expect(message).toContainText('Please read the notes')
  await expect(message).toContainText('build-notes.txt')
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })
  expect(stdinTexts(r).some((t) => t.includes('build-notes.txt'))).toBe(true)
})

test('2.3: an attachment with plan feedback is refused with the box unchanged; without it the text is taken as feedback', async () => {
  const files = makeFiles()
  rig = await launchRig({ scenario: 'plan-changes', repos: [{ name: 'api' }, { name: 'web' }] })
  const r = rig
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!, r.repos['web']!])
  await startSession(page, { request: 'Add retries' })
  const first = page.locator('[data-plan-card="proposed"]')
  await expect(first.locator('[data-plan-worker]')).toHaveCount(2)
  const messagesBefore = await sentMessages(page).count()

  await queuePicker(r, [files.text])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(composerChips(page)).toHaveCount(1)
  await messageBox(page).fill('Use one worker, not two')
  await page.getByRole('button', { name: 'Send' }).click()

  await expect(page.getByText("Attachments can't be added to plan feedback.")).toBeVisible()
  await expect(messageBox(page)).toHaveValue('Use one worker, not two')
  await expect(composerChips(page)).toHaveCount(1)
  await expect(sentMessages(page)).toHaveCount(messagesBefore)
  await expect(first).toBeVisible()
  await expect(page.locator('[data-plan-card="replaced"]')).toHaveCount(0)

  // Without the attachment the same text is the plan feedback, as in the plan specs.
  await page.getByRole('button', { name: 'Remove build-notes.txt' }).click()
  await expect(composerChips(page)).toHaveCount(0)
  await page.getByRole('button', { name: 'Send' }).click()
  const replaced = page.locator('[data-plan-card="replaced"]')
  await expect(replaced).toBeVisible()
  await expect(replaced.locator('[data-plan-tag]')).toHaveText('Replaced')
  await expect(
    page.locator('[data-plan-card="proposed"]').locator('[data-plan-worker]')
  ).toHaveCount(1)
})

// Slice 6: native image input on the Claude brain (Codex and Cursor are in attachments-providers.spec.ts).

test('2.4 + 2.5: an image and a PDF sent to a Claude brain: no warning, the image as a base64 block after the text block, nothing native for the PDF', async () => {
  const png = tinyPng()
  const files = makeFiles()
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await openSession(r)

  await queuePicker(r, [files.pdf])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await pasteImage(page, png)
  await expect(composerChips(page)).toHaveCount(2)
  // Claude reads both kinds: no warning anywhere in the box.
  await expect(page.locator('[data-composer]')).not.toContainText("can't read")
  await expect(page.locator('[data-composer] [data-notice-text]')).toHaveCount(0)

  await messageBox(page).fill('What do these show?')
  await page.getByRole('button', { name: 'Send' }).click()
  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(message).toContainText('layout-sheet.pdf')
  const thumb = message.locator('img[data-attachment-thumb]')
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })

  type Block = { type: string; text?: string; source?: Record<string, string> }
  const contents = readFakeLog(r)
    .map((l) => (l['stdin'] as { message?: { content?: Block[] } } | undefined)?.message?.content)
    .filter((c): c is Block[] => Array.isArray(c))
  const content = contents.find((c) => c.some((b) => b.type === 'image'))
  expect(content, 'a user message with an image block').toBeTruthy()
  expect(content!.map((b) => b.type)).toEqual(['text', 'image'])

  const [sessionId] = sessionIds(r)
  const attachmentsDir = join(r.userDataDir, 'sessions', sessionId!, 'attachments')
  const text = content![0]!.text!
  expect(text.startsWith('What do these show?')).toBe(true)
  expect(text).toContain('[Attachments for this message]')
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  expect(lines).toHaveLength(2)
  for (const name of ['layout-sheet.pdf', 'Pasted image 1']) {
    const line = lines.find((l) => l.includes(name))
    expect(line, name).toBeTruthy()
    const path = line!.split(' · ').at(-1)!
    expect(path.startsWith(`${attachmentsDir}/`)).toBe(true)
    expect(existsSync(path)).toBe(true)
  }

  const image = content![1]!
  expect(image.source?.['type']).toBe('base64')
  expect(image.source?.['media_type']).toBe('image/png')
  expect(Buffer.from(image.source!['data']!, 'base64').equals(png)).toBe(true)
  // The PDF is path-only: no second block, and its bytes are nowhere in the message.
  expect(JSON.stringify(content)).not.toContain(tinyPdf().toString('base64'))
})
