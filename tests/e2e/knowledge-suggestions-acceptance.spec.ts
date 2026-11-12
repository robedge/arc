// @spec: 011-learning-loop
// @regression
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  readFakeLog,
  startSession
} from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 011 acceptance cases for the criteria the slice specs left to unit tests or to one half of the behaviour. Each
 * case drives the whole app: the brain is the fake Claude CLI, nothing outside the temporary HOME is touched and no
 * model call is made. The cases are named by criterion: section number, then position in the functional spec.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const chip = (page: Page) =>
  page.getByRole('button', { name: /Knowledge suggestions, \d+ waiting/ })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Knowledge suggestions' })
const eventRows = (page: Page, kind: string) =>
  eventLog(page).and(page.locator(`[data-event-kind="${kind}"]`))
const suggestionsLine = (page: Page) => page.locator('[data-knowledge-suggestions-line]')
const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' })
const orderCard = (page: Page) =>
  dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Orders table is partitioned by month'
  })
const pricingCard = (page: Page) =>
  dialog(page).getByRole('article', { name: 'Knowledge suggestion: Checkout calls pricing twice' })

/** Every file under `root`, as paths relative to it. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const walk = (dir: string, prefix: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`]
    )
  return walk(root, '')
}

/** The app-folder knowledge root of the first group (the only one these tests create). */
function appKnowledgeRoot(userDataDir: string): string {
  const groups = join(userDataDir, 'groups')
  const id = existsSync(groups) ? readdirSync(groups)[0] : undefined
  return id ? join(groups, id, 'knowledge') : join(groups, 'none', 'knowledge')
}

function knowledgeFiles(userDataDir: string): string[] {
  return filesUnder(appKnowledgeRoot(userDataDir))
}

/** The results of the brain's `suggest_knowledge_update` calls, in order, from the fake CLI log. */
function suggestResults(r: Rig): { isError: boolean; text: string }[] {
  return readFakeLog(r)
    .map((l) => l['mcpResult'] as { tool?: string; isError: boolean; text: string } | undefined)
    .filter(
      (m): m is { tool: string; isError: boolean; text: string } =>
        m?.tool === 'suggest_knowledge_update'
    )
}

/** The text of every user message the fake brain received, from the fake CLI log. */
function receivedUserTexts(r: Rig): string[] {
  return readFakeLog(r)
    .map((l) => l['stdin'] as { type?: string; message?: { content?: unknown } } | undefined)
    .filter((s) => s?.type === 'user')
    .map((s) => {
      const content = s?.message?.content
      if (typeof content === 'string') return content
      return Array.isArray(content)
        ? content.map((block: { text?: string }) => block.text ?? '').join('')
        : ''
    })
}

async function sendToBrain(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder('Message the brain')
  await box.fill(text)
  await box.press('Enter')
}

const SERVICE_MAP_FRONT = '---\ntitle: Service map\n---\n'
const SERVICE_MAP_BODY = [
  'The api service talks to the queue.',
  'Retries use a fixed delay of 30 seconds.',
  'Alerts go to the on-call channel.',
  'Deploys happen on weekdays only.',
  ''
].join('\n')

/** Writes the note the `ks-update` brain suggests an edit to and returns its path. */
function seedServiceMap(userDataDir: string): string {
  const notesDir = join(appKnowledgeRoot(userDataDir), 'Notes')
  mkdirSync(notesDir, { recursive: true })
  const path = join(notesDir, 'Service map.md')
  writeFileSync(path, SERVICE_MAP_FRONT + SERVICE_MAP_BODY)
  return path
}

// ---- 2.1: when the brain suggests --------------------------------------------------------------------------------

test('2.1-2 and 2.1-3: a brain that only answers from the knowledge shows no suggestion, line or message, and asked later it adds nothing of its own', async () => {
  const r = await launchRig({ scenario: 'ks-none', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })

  // The answer arrives and is the whole of the turn: no chip, no line, no event and nothing written.
  await expect(conversation(page).getByText('as the Notes already say')).toBeVisible({
    timeout: 20_000
  })
  await expect(chip(page)).toHaveCount(0)
  await expect(suggestionsLine(page)).toHaveCount(0)
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(0)
  await expect(conversation(page)).not.toContainText(/suggestion/i)
  await expect(conversation(page).locator('[data-message-role="system"]')).toHaveCount(0)
  expect(suggestResults(r)).toEqual([])
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  // Asked in plain words, the brain answers (its own words) and Arc adds nothing around it.
  await sendToBrain(page, 'NONE-ASK: what should we add to the knowledge?')
  await expect(conversation(page).getByText('I have no suggestions for this group')).toBeVisible({
    timeout: 20_000
  })
  await expect(chip(page)).toHaveCount(0)
  await expect(suggestionsLine(page)).toHaveCount(0)
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(0)
  await expect(conversation(page).locator('[data-message-role="system"]')).toHaveCount(0)
  expect(suggestResults(r)).toEqual([])
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  // Arc sent no turn of its own to ask for suggestions: the brain only heard the user's two messages.
  const heard = receivedUserTexts(r)
  expect(heard).toHaveLength(2)
  expect(heard.some((t) => t.startsWith('[Arc]'))).toBe(false)
  expect(heard[1]).toContain('NONE-ASK: what should we add to the knowledge?')
})

// ---- 2.2: what a suggestion contains -----------------------------------------------------------------------------

test('2.2-4: with a PDF in Docs the brain cannot target it, and only the text suggestion appears', async () => {
  const r = await launchRig({ scenario: 'ks-pdf', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const docsDir = join(appKnowledgeRoot(r.userDataDir), 'Docs')
  mkdirSync(docsDir, { recursive: true })
  const pdf = join(docsDir, 'Schema.pdf')
  const pdfBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n\u0000\u0001'
  )
  writeFileSync(pdf, pdfBytes)

  await startSession(page, { request: 'What does the schema PDF say?', mode: 'Autonomous' })
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  // Changing the PDF and adding a PDF were both refused by the main process; the text note was stored.
  const results = suggestResults(r)
  expect(results).toHaveLength(3)
  for (const refused of results.slice(0, 2)) {
    expect(refused.isError).toBe(true)
    expect(refused.text).toContain('not_text_file')
  }
  expect(results[2]!.isError).toBe(false)
  expect(JSON.parse(results[2]!.text)).toMatchObject({ ok: true })

  // The one card is the text note, in Docs; nothing in the list or the history names the PDF.
  await chip(page).click()
  const cards = dialog(page).locator(
    '[data-knowledge-suggestions-list] [data-knowledge-suggestion]'
  )
  await expect(cards).toHaveCount(1)
  await expect(cards.first().locator('[data-destination]')).toHaveText(
    'Docs › New note: Orders status'
  )
  await expect(dialog(page)).not.toContainText(/\.pdf/i)
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-suggested')).not.toContainText(/\.pdf/i)

  // Accepting it leaves the PDF byte for byte as it was.
  await cards
    .first()
    .getByRole('button', { name: /^Accept:/ })
    .click()
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Docs › Orders status/
  )
  expect(readFileSync(pdf).equals(pdfBytes)).toBe(true)
  expect(knowledgeFiles(r.userDataDir).sort()).toEqual(['Docs/Orders status.md', 'Docs/Schema.pdf'])
})

// ---- 2.4: accepting, editing and discarding ----------------------------------------------------------------------

test('2.4-9 and 2.4-13: a note changed in Arc own editor after the suggestion is refused with "changed since" and keeps the typed text', async () => {
  const r = await launchRig({ scenario: 'ks-update', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const path = seedServiceMap(r.userDataDir)
  await startSession(page, { request: 'How do retries work?', mode: 'Autonomous' })
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })

  // The user opens the note in Arc's editor and types into it; autosave writes it to the file.
  await page.getByRole('tab', { name: 'Notes' }).click()
  await page
    .getByRole('list', { name: 'Items' })
    .getByRole('button', { name: /Service map/ })
    .click()
  await expect(page.locator('.cm-content')).toContainText('Retries use a fixed delay')
  await page.locator('.cm-content').click()
  await page.keyboard.type('Typed in Arc: the queue is local only.')
  await expect.poll(() => readFileSync(path, 'utf8'), { timeout: 10_000 }).toContain('Typed in Arc')
  const typed = readFileSync(path, 'utf8')

  // Back in the session, Accept refuses and the note keeps what the user typed.
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await chip(page).click()
  const card = dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Retries use exponential backoff'
  })
  await card.getByRole('button', { name: 'Accept: Retries use exponential backoff' }).click()
  await expect(card.locator('[data-knowledge-suggestion-problem]').getByRole('alert')).toHaveText(
    'This note has changed since the suggestion was made.'
  )
  expect(readFileSync(path, 'utf8')).toBe(typed)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)
})

test('2.4-14: accepting into a linked folder under version control changes the file and makes no commit', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page, app } = r
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'arc-ks-git-')))
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.email=a@b.c', '-c', 'user.name=t', ...args], {
      cwd: folder,
      encoding: 'utf8'
    })
  try {
    git('init', '-q')
    await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
    await page.getByRole('tab', { name: 'Notes' }).click()
    await app.evaluate(
      (_e, p) => {
        ;(
          globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
        ).__e2e.queueOpenDialog(p)
      },
      [folder]
    )
    const panel = page.getByRole('region', { name: 'Knowledge storage' })
    await panel.getByRole('button', { name: 'Link folder…' }).click()
    await expect(panel.getByText(folder)).toBeVisible()
    await page.getByRole('tab', { name: 'Sessions' }).click()

    // Whatever Arc wrote while linking is committed, so the history has one commit and a clean tree.
    git('add', '-A')
    git('commit', '-q', '--allow-empty', '-m', 'before the suggestion')
    const logBefore = git('log', '--format=%H %s')
    expect(git('status', '--porcelain')).toBe('')

    await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
    await expect(chip(page)).toBeVisible({ timeout: 20_000 })
    await expect(chip(page).locator('[data-count]')).toHaveText('2')
    await chip(page).click()
    await orderCard(page)
      .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
      .click()
    await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
      /Added to Notes › Orders partitioning/
    )

    // The file is in the linked folder and untracked: no commit, no staging, no branch or tag.
    expect(readFileSync(join(folder, 'Notes', 'Orders partitioning.md'), 'utf8')).toBe(
      'The orders table is partitioned by month.\nQueries should filter on created_at to hit one partition.'
    )
    expect(git('status', '--porcelain')).toMatch(/^\?\? "?Notes\//m)
    expect(git('log', '--format=%H %s')).toBe(logBefore)
    expect(git('diff', '--cached', '--name-only')).toBe('')
    expect(git('branch', '--list').trim().split('\n')).toHaveLength(1)
    expect(git('tag', '--list')).toBe('')
    expect(knowledgeFiles(r.userDataDir)).toEqual([])
  } finally {
    try {
      chmodSync(folder, 0o755)
    } catch {
      // already gone
    }
    rmSync(folder, { recursive: true, force: true })
  }
})

// ---- 2.6: the session record -------------------------------------------------------------------------------------

test('2.6-1 and 2.6-2: the event history names the title and destination of an accepted suggestion and the title of a discarded one', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await expect(chip(page).locator('[data-count]')).toHaveText('2', { timeout: 20_000 })

  await chip(page).click()
  await orderCard(page)
    .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
    .click()
  await pricingCard(page)
    .getByRole('button', { name: 'Discard: Checkout calls pricing twice' })
    .click()
  await expect(chip(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  // Each made suggestion is listed, then one entry per outcome.
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(2)
  const accepted = eventRows(page, 'knowledge-accepted')
  await expect(accepted).toHaveCount(1)
  await expect(accepted).toContainText('Orders table is partitioned by month')
  await expect(accepted).toContainText('Notes › New note: Orders partitioning')
  await expect(accepted).toContainText('Accepted')
  await expect(accepted).not.toContainText('Discarded')
  const discarded = eventRows(page, 'knowledge-discarded')
  await expect(discarded).toHaveCount(1)
  await expect(discarded).toContainText('Checkout calls pricing twice')
  await expect(discarded).toContainText('Discarded')
  await expect(discarded).not.toContainText('Accepted')
})
