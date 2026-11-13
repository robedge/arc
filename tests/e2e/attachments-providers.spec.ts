// @spec: 012-brain-attachments
// @regression
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  composerChips,
  pasteImage,
  queuePicker,
  sentMessages,
  tinyPdf,
  tinyPng
} from './attachments-rig'
import { launchCodexRig, readCodexLog, setDefault } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { launchCursorRig, readCursorLog } from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, startSession } from './sessions-rig'

/**
 * Spec 012 slice 6: a Codex brain and a Cursor brain are sent an image and a PDF. Each gets the text block and the
 * native image input, nothing native for the PDF, and the user sees the can't-read warning for the PDF. Fake CLIs only.
 * (The Claude brain's run is in attachments.spec.ts.)
 */

let rig: CodexRig | CursorRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const SENT_TEXT = 'What do these show?'
const PNG = tinyPng()

function makePdf(): string {
  scratch = mkdtempSync(join(tmpdir(), 'arc-att-'))
  const pdf = join(scratch, 'layout-sheet.pdf')
  writeFileSync(pdf, tinyPdf())
  return pdf
}

const notices = (page: Page) => page.locator('[data-composer] [data-attachment-notices]')
const warning = (brain: string): string =>
  `${brain} can't read PDFs. It will be sent as a file the brain may not be able to open.`

type Rec = Record<string, unknown>

/** The one session folder under `<userData>/sessions`. */
function readdirOne(dir: string): string {
  const [only, ...rest] = readdirSync(dir)
  expect(rest).toEqual([])
  return only!
}

/** Attaches a generated PDF with the picker and a generated PNG by paste, checks the warning, and sends. */
async function attachAndSend(r: CodexRig | CursorRig, brain: string, pdf: string): Promise<void> {
  const { page } = r
  await queuePicker(r, [pdf])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await pasteImage(page, PNG)
  await expect(composerChips(page)).toHaveCount(2)
  await expect(composerChips(page).first()).toContainText('layout-sheet.pdf')
  await expect(composerChips(page).last()).toContainText('Pasted image 1')

  // Exactly the one warning, for the PDF only, and the user can still send.
  await expect(notices(page).locator('[data-notice-warning-text]')).toHaveText([warning(brain)])
  const send = page.getByRole('button', { name: 'Send' })
  await expect(send).toBeEnabled()
  await page.getByLabel('Message to the brain').fill(SENT_TEXT)
  await send.click()

  // The sent message shows the image as a thumbnail and the PDF by name.
  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(message).toContainText('layout-sheet.pdf')
  const thumb = message.locator('img[data-attachment-thumb]')
  await expect(thumb).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect
    .poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0)
  await expect(composerChips(page)).toHaveCount(0)
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })
}

/** The text block holds the user text and lists both files with their stored paths; returns the image's path. */
function expectTextBlock(text: string, attachmentsDir: string): { image: string } {
  expect(text.startsWith(SENT_TEXT)).toBe(true)
  expect(text).toContain('[Attachments for this message]')
  const lines = text.split('\n').filter((l) => l.startsWith('- '))
  expect(lines).toHaveLength(2)
  const pdfLine = lines.find((l) => l.includes('layout-sheet.pdf'))!
  const imageLine = lines.find((l) => l.includes('Pasted image 1'))!
  expect(pdfLine).toContain(' · pdf · ')
  expect(imageLine).toContain(' · image · ')
  const pathOf = (line: string): string => line.split(' · ').at(-1)!
  for (const line of [pdfLine, imageLine]) {
    expect(pathOf(line).startsWith(`${attachmentsDir}/`)).toBe(true)
    expect(existsSync(pathOf(line))).toBe(true)
  }
  return { image: pathOf(imageLine) }
}

test('Codex brain: an image goes in as a localImage after the text block, the PDF only in the block, and the PDF shows the warning', async () => {
  const pdf = makePdf()
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'att-send',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Fake Deep')
  await startSession(page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(page.getByText('Ready for the files.').first()).toBeVisible({ timeout: 30_000 })

  await attachAndSend(r, 'Codex', pdf)

  const turns = readCodexLog(r).flatMap((l) => {
    const recv = l['recv'] as { method?: string; params?: { input?: Rec[] } } | undefined
    return recv?.method === 'turn/start' ? [recv.params?.input ?? []] : []
  })
  const input = turns.find((i) => i.some((item) => item['type'] === 'localImage'))
  expect(input, 'a turn/start with a localImage').toBeTruthy()
  expect(input!.map((item) => item['type'])).toEqual(['text', 'localImage'])
  const attachmentsDir = join(r.userDataDir, 'sessions')
  const sessionDir = join(attachmentsDir, readdirOne(attachmentsDir), 'attachments')
  const { image } = expectTextBlock(input![0]!['text'] as string, sessionDir)
  expect(input![1]).toEqual({ type: 'localImage', path: image })
  expect(readFileSync(image).equals(PNG)).toBe(true)
  // Nothing native for the PDF: no input item mentions it.
  expect(JSON.stringify(input!.slice(1))).not.toContain('layout-sheet')
})

test('Cursor brain: an image goes in as an image block after the text block, the PDF only in the block, and the PDF shows the warning', async () => {
  const pdf = makePdf()
  const r = await launchCursorRig({ cursorScenario: 'att-send', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Auto (default)')
  await startSession(page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(page.getByText('Ready for the files.').first()).toBeVisible({ timeout: 30_000 })

  await attachAndSend(r, 'Cursor', pdf)

  const prompts = readCursorLog(r).flatMap((l) => {
    const recv = l['recv'] as { method?: string; params?: { prompt?: Rec[] } } | undefined
    return recv?.method === 'session/prompt' ? [recv.params?.prompt ?? []] : []
  })
  const prompt = prompts.find((p) => p.some((block) => block['type'] === 'image'))
  expect(prompt, 'a session/prompt with an image block').toBeTruthy()
  expect(prompt!.map((block) => block['type'])).toEqual(['text', 'image'])
  const attachmentsDir = join(r.userDataDir, 'sessions')
  const sessionDir = join(attachmentsDir, readdirOne(attachmentsDir), 'attachments')
  expectTextBlock(prompt![0]!['text'] as string, sessionDir)
  expect(prompt![1]).toEqual({
    type: 'image',
    data: PNG.toString('base64'),
    mimeType: 'image/png'
  })
  expect(JSON.stringify(prompt!.slice(1))).not.toContain('layout-sheet')
})

test('New Session dialog: with Codex picked, the PDF warning shows before Start, and picking Claude hides it', async () => {
  const pdf = makePdf()
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'att-send',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Brain', { exact: true }).selectOption({ label: 'Fake Deep' })
  await queuePicker(r, [pdf])
  await dialog.getByRole('button', { name: 'Attach files' }).click()
  const shown = dialog.locator('[data-attachment-notices] [data-notice-warning-text]')
  await expect(shown).toHaveText([warning('Codex')])
  await expect(dialog.getByRole('button', { name: 'Start' })).toBeEnabled()

  await dialog.getByLabel('Brain', { exact: true }).selectOption({ label: 'Sonnet' })
  await expect(shown).toHaveCount(0)
})
