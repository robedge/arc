// @spec: 004-change-review
// @regression
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { eventLog, git, readFakeLog, workerCard } from './sessions-rig'
import type { Rig } from './sessions-rig'
import {
  closeReview,
  fileRow,
  launchReviewRig,
  openGate,
  openReview,
  repoGroup,
  reviewScreen,
  sessionBranch,
  spawnAndMerge
} from './review-rig'

// One Arc run for the whole file: the tests build on each other, in this order.
test.describe.configure({ mode: 'serial' })
test.setTimeout(120_000)

let rig: Rig
let remote = ''
const scratch: string[] = []
let seedDev = ''
test.beforeAll(async () => {
  rig = await launchReviewRig()
  // A temporary bare remote for the api repository only; nothing here ever pushes anywhere else.
  const remoteRoot = mkdtempSync(join(tmpdir(), 'arc-s4-remote-'))
  scratch.push(remoteRoot)
  remote = join(remoteRoot, 'remote.git')
  git(rig.root, 'init', '--bare', '-b', 'dev', remote)
  git(rig.repos['api']!, 'remote', 'add', 'origin', remote)
  seedDev = git(rig.repos['api']!, 'rev-parse', 'dev').trim()
  await spawnAndMerge(rig)
})
test.afterAll(async () => {
  await rig?.dispose()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

const undoDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Undo changes' })
const pushDialog = (page: Page): Locator => page.getByRole('dialog', { name: 'Push branch' })
const sendButton = (page: Page, n: number): Locator =>
  page.getByRole('button', { name: `Send ${n} ${n === 1 ? 'note' : 'notes'} to brain` })

function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

test('2.3: Undo changes asks first; Cancel leaves the file unchanged', async () => {
  const { page } = rig
  await openReview(page)
  const row = fileRow(page, 'api', 'config.txt')
  await row.click()
  await page.getByRole('button', { name: 'Undo changes' }).click()
  const dialog = undoDialog(page)
  await expect(dialog).toContainText(
    `Undo all of this session's changes to api/config.txt? This adds a commit to ${sessionBranch(rig.repos['api']!)}.`
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row).toBeVisible()
  await expect(row).toContainText('Changed')
  expect(readFileSync(join(rig.repos['api']!, 'config.txt'), 'utf8')).toContain('retry limit = 3')
})

test('2.3: a worker still on the file is named; confirming removes the file and logs it', async () => {
  const { page, repos } = rig
  await openReview(page)
  const row = fileRow(page, 'api', 'README.md')
  await row.click()
  await page.getByRole('button', { name: 'Undo changes' }).click()
  const dialog = undoDialog(page)
  await expect(dialog).toContainText('W5 is still working on this file.')
  await expect(dialog).toContainText('Its next merge may bring the change back.')
  await dialog.getByRole('button', { name: 'Undo changes' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(row).toHaveCount(0)
  await expect(
    eventLog(page).filter({ hasText: 'You undid changes to api/README.md' })
  ).toHaveCount(1)
  // The user's own copy has the file as it was when the session started.
  expect(readFileSync(join(repos['api']!, 'README.md'), 'utf8')).toBe('hello\n')
  expect(git(repos['api']!, 'log', '-1', '--format=%s').trim()).toBe(
    'Undo session changes to README.md'
  )
})

test("2.3: undoing a file the session added deletes it from the user's copy", async () => {
  const { page, repos } = rig
  await openReview(page)
  expect(existsSync(join(repos['api']!, 'src', 'client.ts'))).toBe(true)
  const row = fileRow(page, 'api', 'src/client.ts')
  await row.click()
  await page.getByRole('button', { name: 'Undo changes' }).click()
  await undoDialog(page).getByRole('button', { name: 'Undo changes' }).click()
  await expect(row).toHaveCount(0)
  expect(existsSync(join(repos['api']!, 'src', 'client.ts'))).toBe(false)
})

test('2.3: the brain is told what the user undid and does not redo it', async () => {
  const { page } = rig
  await openReview(page)
  const row = fileRow(page, 'api', 'logo.png')
  await row.click()
  await page.getByRole('button', { name: 'Undo changes' }).click()
  await undoDialog(page).getByRole('button', { name: 'Undo changes' }).click()
  await expect(row).toHaveCount(0)

  await closeReview(page)
  await page.getByLabel('Message to the brain').fill('Anything else to check?')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByText('Understood: I will not redo the README.md change.')).toBeVisible()
  const note = stdinTexts(rig).find((t) => t.includes('The user undid'))
  expect(note).toBeDefined()
  expect(note).toContain('api/logo.png')
  expect(note).toContain("Don't make")
  expect(note).toContain('again without asking.')
})

test('2.4: a note appears under its line and the button counts the notes; deleting drops the count', async () => {
  const { page } = rig
  await openReview(page)
  await expect(sendButton(page, 0)).toBeDisabled()
  await fileRow(page, 'api', 'config.txt').click()
  const view = page.locator('[data-diff-view]')

  await view.getByRole('button', { name: 'Add note on line 6 (new)' }).click({ force: true })
  await view
    .getByRole('textbox', { name: 'Note on line 6 (new)' })
    .fill('This retry limit should come from config')
  await view.getByRole('button', { name: 'Save' }).click()
  const slot = view.locator('[data-note-slot="new:6"]')
  await expect(slot.locator('[data-note="draft"]')).toContainText(
    'This retry limit should come from config'
  )
  // The note sits directly under the line it belongs to.
  const order = await view
    .locator('[data-diff-row]')
    .evaluateAll((rows) =>
      rows.map((r) =>
        r.querySelector('[data-note-slot]')
          ? 'note'
          : (r.querySelector('[data-diff-line]')?.textContent ?? '')
      )
    )
  const noteAt = order.indexOf('note')
  expect(order[noteAt - 1]).toContain('retry limit = 3')
  await expect(sendButton(page, 1)).toBeVisible()

  await view.getByRole('button', { name: 'Add note on line 6 (old)' }).click({ force: true })
  await view
    .getByRole('textbox', { name: 'Note on line 6 (old)' })
    .fill('Why was this value fixed?')
  await view.getByRole('button', { name: 'Save' }).click()
  await expect(sendButton(page, 2)).toBeVisible()

  for (const anchor of ['old:6', 'new:6']) {
    await view
      .locator(`[data-note-slot="${anchor}"] [data-note="draft"]`)
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(view.locator(`[data-note-slot="${anchor}"] [data-note]`)).toHaveCount(0)
  }
  await expect(sendButton(page, 0)).toBeDisabled()
})

test('2.4: sending posts one message with every note and its file and line; a sent note goes stale when a merge changes its line', async () => {
  const { page } = rig
  await openReview(page)
  const view = page.locator('[data-diff-view]')
  const add = async (line: number, text: string): Promise<void> => {
    await view
      .getByRole('button', { name: `Add note on line ${line} (new)` })
      .click({ force: true })
    await view.getByRole('textbox', { name: `Note on line ${line} (new)` }).fill(text)
    await view.getByRole('button', { name: 'Save' }).click()
  }
  await fileRow(page, 'api', 'config.txt').click()
  await add(6, 'This retry limit should come from config')
  // An unchanged line the diff shows for context.
  await add(9, 'Keep this last line')
  await fileRow(page, 'api', 'src/queue.ts').click()
  await add(2, 'Name this function')
  await expect(sendButton(page, 3)).toBeVisible()

  await sendButton(page, 3).click()
  await expect(sendButton(page, 0)).toBeDisabled()
  await closeReview(page)

  const sent = page.locator('[data-message-role="user"]').filter({ hasText: 'Review notes (3):' })
  await expect(sent).toHaveCount(1)
  await expect(sent).toContainText('api · config.txt · line 6 (new)')
  await expect(sent).toContainText('This retry limit should come from config')
  await expect(sent).toContainText('api · config.txt · line 9 (new)')
  await expect(sent).toContainText('Keep this last line')
  await expect(sent).toContainText('api · src/queue.ts · line 2 (new)')
  await expect(sent).toContainText('Name this function')
  await expect(page.getByText('Applying your review notes.')).toBeVisible()
  expect(stdinTexts(rig).filter((t) => t.includes('Review notes (3):'))).toHaveLength(1)

  // The notes stay in the review, marked Sent, and can no longer be deleted.
  await openReview(page)
  await fileRow(page, 'api', 'config.txt').click()
  const note = view.locator('[data-note-slot="new:9"] [data-note="sent"]')
  await expect(note).toContainText('Sent')
  await expect(note.locator('[data-note-stale]')).toHaveCount(0)
  await expect(note.getByRole('button', { name: 'Delete' })).toHaveCount(0)

  openGate(rig)
  await expect(workerCard(page, 'W4 · api-late')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 60_000
  })
  await expect(note.locator('[data-note-stale]')).toHaveText('Changed since you wrote this')
  // The sent note on a line nobody touched later is still current.
  const unchanged = view.locator('[data-note-slot="new:6"] [data-note="sent"]')
  await expect(unchanged).toContainText('Sent')
  await expect(unchanged.locator('[data-note-stale]')).toHaveCount(0)
})

test('2.6: Push branch shows the exact command and pushes nothing until Push', async () => {
  const { page, repos } = rig
  const branch = sessionBranch(repos['api']!)
  await openReview(page)
  await page.getByRole('button', { name: 'Push branch' }).first().click()
  const dialog = pushDialog(page)
  await expect(dialog.locator('[data-push-command]')).toHaveText(`git push -u origin ${branch}`)
  await expect(dialog.getByRole('button', { name: 'Push', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()
  expect(git(remote, 'branch', '--list', branch).trim()).toBe('')

  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  expect(git(remote, 'branch', '--list', branch).trim()).toBe('')
  await expect(page.locator('[data-push-tag]')).toHaveCount(0)

  // A repository without a remote cannot be pushed.
  await expect(page.locator('[data-review-push]').nth(1)).toContainText('No remote configured')
})

test("2.6: a rejected push shows the remote's message and does not mark the repository Pushed", async () => {
  const { page, repos } = rig
  const branch = sessionBranch(repos['api']!)
  // Someone else already put a different commit on that branch of the remote.
  const other = mkdtempSync(join(tmpdir(), 'arc-s4-other-'))
  scratch.push(other)
  git(other, 'init', '-b', 'dev')
  git(other, 'commit', '--allow-empty', '-m', 'Somebody else')
  git(other, 'push', remote, `HEAD:refs/heads/${branch}`)

  await openReview(page)
  await page.getByRole('button', { name: 'Push branch' }).first().click()
  const dialog = pushDialog(page)
  await dialog.getByRole('button', { name: 'Push', exact: true }).click()
  const error = dialog.locator('[data-push-error]')
  await expect(error).toBeVisible({ timeout: 30_000 })
  await expect(error.getByRole('region', { name: 'Message from git' })).toContainText(
    /rejected|non-fast-forward|fetch first/
  )
  await expect(dialog).toBeVisible()
  await expect(page.locator('[data-push-tag]')).toHaveCount(0)
  expect(git(remote, 'log', '-1', '--format=%s', branch).trim()).toBe('Somebody else')

  // Fixing the remote and pushing again from the same dialog succeeds.
  git(remote, 'update-ref', '-d', `refs/heads/${branch}`)
  await dialog.getByRole('button', { name: 'Push', exact: true }).click()
  await expect(dialog).toHaveCount(0, { timeout: 30_000 })
  const tag = repoGroup(page, 'api').locator('[data-push-tag]')
  await expect(tag).toHaveText(/^Pushed \d{2}:\d{2}/)
  expect(git(remote, 'rev-parse', branch).trim()).toBe(
    git(repos['api']!, 'rev-parse', branch).trim()
  )
  await expect(repoGroup(page, 'web').locator('[data-push-tag]')).toHaveCount(0)
  // Arc never merges into dev itself.
  expect(git(repos['api']!, 'rev-parse', 'dev').trim()).toBe(seedDev)
  expect(git(remote, 'branch', '--list', 'dev').trim()).toBe('')
  await expect(reviewScreen(page)).toBeVisible()
})
