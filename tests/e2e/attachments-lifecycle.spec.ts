// @spec: 012-brain-attachments
// @regression
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { composerChips, queuePicker, sentMessages, tinyPng, underBox } from './attachments-rig'
import { createGroupWithProjects, launchRig, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 012 slice 8: sent attachments survive a restart and a deleted original, a deleted session takes its
 * attachments folder with it, the staging folder is emptied at start, and a stray folder is swept. Fake CLIs only.
 */

let rig: Rig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const loaded = (img: Element): boolean => (img as HTMLImageElement).naturalWidth > 0
const TEXT = 'Release notes\nThe nightly build takes four minutes.\n'

async function openSession(r: Rig): Promise<void> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Check the build', mode: 'Autonomous' })
  await expect(r.page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
}

/** After a relaunch: back to the group's first session. */
async function reopenSession(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
}

const sessionIds = (r: Rig): string[] => {
  const root = join(r.userDataDir, 'sessions')
  return existsSync(root) ? readdirSync(root) : []
}

/** Attaches a generated PNG and a text file by path, deletes both originals, sends. Returns the session id. */
async function sendImageAndText(r: Rig): Promise<string> {
  scratch = mkdtempSync(join(tmpdir(), 'arc-life-'))
  const png = join(scratch, 'site-capture.png')
  const text = join(scratch, 'release-notes.txt')
  writeFileSync(png, tinyPng())
  writeFileSync(text, TEXT)
  await openSession(r)
  const { page } = r
  await queuePicker(r, [png, text])
  await page.getByRole('button', { name: 'Attach files' }).click()
  await expect(underBox(page).getByRole('listitem')).toHaveCount(2)
  rmSync(png)
  rmSync(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(sentMessages(page).last().locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(page.getByText('Got the files.')).toBeVisible({ timeout: 30_000 })
  const ids = sessionIds(r)
  expect(ids).toHaveLength(1)
  return ids[0]!
}

test('8.1 + 8.4: sent attachments survive a restart and deleted originals; a stray folder is swept, the real ones stay', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const sessionId = await sendImageAndText(r)
  const attachmentsDir = join(r.userDataDir, 'sessions', sessionId, 'attachments')
  const before = readdirSync(attachmentsDir)
  expect(before.length).toBeGreaterThan(0)

  // A crash leftover: a folder with no row, older than the sweep's 60 second grace.
  const stray = join(attachmentsDir, '0'.repeat(25) + '1')
  mkdirSync(stray)
  writeFileSync(join(stray, 'stray.txt'), 'left behind')
  const old = new Date(Date.now() - 10 * 60_000)
  utimesSync(stray, old, old)

  await r.relaunch()
  const { page } = r
  await reopenSession(page)

  const message = sentMessages(page).last()
  await expect(message.locator('[data-attachment-chip]')).toHaveCount(2)
  await expect(message).toContainText('release-notes.txt')
  await expect(message).toContainText(`${TEXT.length} B`)
  const thumb = message.locator('img[data-attachment-thumb]')
  await expect(thumb).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => thumb.evaluate(loaded)).toBe(true)

  await message.getByRole('button', { name: 'Preview site-capture.png' }).click()
  const preview = page.getByRole('dialog', { name: 'site-capture.png' })
  const full = preview.locator('img[data-image-preview]')
  await expect(full).toHaveAttribute('src', /^arc-attachment:\/\/sent\//)
  await expect.poll(() => full.evaluate(loaded)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(preview).toHaveCount(0)

  // The sweep runs after start: the stray folder goes, the real folders and their files stay.
  await expect.poll(() => existsSync(stray), { timeout: 15_000 }).toBe(false)
  expect(readdirSync(attachmentsDir).sort()).toEqual(before.sort())
  for (const name of before) {
    const files = readdirSync(join(attachmentsDir, name))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(statSync(join(attachmentsDir, name, f)).size).toBeGreaterThan(0)
  }
})

test('8.2: deleting the session removes its attachments folder and the session from the list', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  const sessionId = await sendImageAndText(r)
  const sessionDir = join(r.userDataDir, 'sessions', sessionId)
  expect(readdirSync(join(sessionDir, 'attachments')).length).toBeGreaterThan(0)

  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  const row = page.locator('[data-session-row]').first()
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: 'Session options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Session' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()

  await expect(page.locator('[data-session-row]')).toHaveCount(0)
  await expect.poll(() => existsSync(join(sessionDir, 'attachments'))).toBe(false)
  expect(existsSync(sessionDir)).toBe(false)
})

test('8.3: a staged, unsent attachment is gone after a relaunch and the box lists none', async () => {
  rig = await launchRig({ scenario: 'att-send', repos: [{ name: 'api' }] })
  const r = rig
  scratch = mkdtempSync(join(tmpdir(), 'arc-life-'))
  const text = join(scratch, 'draft-notes.txt')
  writeFileSync(text, TEXT)
  await openSession(r)
  await queuePicker(r, [text])
  await r.page.getByRole('button', { name: 'Attach files' }).click()
  await expect(underBox(r.page).getByRole('listitem')).toHaveCount(1)
  const staging = join(r.userDataDir, 'attachment-staging')
  await expect
    .poll(() => (existsSync(staging) ? readdirSync(staging).length : 0))
    .toBeGreaterThan(0)

  await r.relaunch()
  const { page } = r
  await reopenSession(page)
  await expect(page.getByLabel('Message to the brain')).toBeVisible()
  await expect(composerChips(page)).toHaveCount(0)
  expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([])
})
