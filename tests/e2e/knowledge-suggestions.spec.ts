// @spec: 011-learning-loop
// @regression
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  chmodSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  readFakeLog,
  startSession
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import { flag, sessionStarts } from './commands-rig'

/**
 * Spec 011 slice 1: the brain suggests new notes with `suggest_knowledge_update`; the session shows them, they can be
 * discarded, they survive a restart and nothing is written to the group's knowledge. Fake CLIs only.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const chip = (page: Page) =>
  page.getByRole('button', { name: /Knowledge suggestions, \d+ waiting/ })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Knowledge suggestions' })
const attentionBadge = (page: Page) =>
  page.getByRole('button', { name: /Needs attention, \d+ waiting/ })
const editor = (page: Page) => dialog(page).locator('[data-knowledge-suggestion-editor]')
const eventRows = (page: Page, kind: string) =>
  eventLog(page).and(page.locator(`[data-event-kind="${kind}"]`))

async function notifications(app: ElectronApplication): Promise<{ title: string; body: string }[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __e2e: { notifications: { title: string; body: string }[] } })
        .__e2e.notifications
  )
}

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

/** Every file under the group's knowledge folder, as paths relative to it. */
function knowledgeFiles(userDataDir: string): string[] {
  return filesUnder(appKnowledgeRoot(userDataDir))
}

/** Makes the folder and each directory in it read-only or writable again (the group's section folders exist already). */
function setWritable(root: string, writable: boolean): void {
  const mode = writable ? 0o755 : 0o555
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(root, e.name))
  if (writable) chmodSync(root, mode)
  for (const dir of dirs) chmodSync(dir, mode)
  if (!writable) chmodSync(root, mode)
}

const ORDERS_TEXT =
  'The orders table is partitioned by month.\nQueries should filter on created_at to hit one partition.'
const orderCard = (page: Page) =>
  dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Orders table is partitioned by month'
  })
const pricingCard = (page: Page) =>
  dialog(page).getByRole('article', { name: 'Knowledge suggestion: Checkout calls pricing twice' })

async function waitForTwoSuggestions(page: Page): Promise<void> {
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
}

test('2.3: two suggested notes show as "Suggestions 2", discarding one survives a restart, and nothing notifies or changes Needs attention', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page, app } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const filesBefore = knowledgeFiles(r.userDataDir)
  // Arc counts as being in the background, so a notification would be sent if suggestions raised one.
  await app.evaluate(() => {
    ;(globalThis as unknown as { __e2e: { forceUnfocused: boolean } }).__e2e.forceUnfocused = true
  })

  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })

  // The chip appears in the header with the count, and is not part of Needs attention.
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  await expect(chip(page)).toContainText('Suggestions')
  await expect(attentionBadge(page)).toHaveCount(0)

  // The dialog lists both cards, newest first, with title, reason, destination and text.
  await chip(page).click()
  await expect(dialog(page)).toBeVisible()
  const cards = dialog(page).locator(
    '[data-knowledge-suggestions-list] [data-knowledge-suggestion]'
  )
  await expect(cards).toHaveCount(2)
  const pricing = dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Checkout calls pricing twice'
  })
  const orders = dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Orders table is partitioned by month'
  })
  await expect(cards.nth(0)).toHaveAttribute('data-knowledge-suggestion', /.+/)
  await expect(cards.nth(0)).toContainText('Checkout calls pricing twice')
  await expect(cards.nth(1)).toContainText('Orders table is partitioned by month')
  for (const card of [pricing, orders]) await expect(card).toHaveAttribute('data-kind', 'new')
  await expect(orders).toContainText(
    'The schema dump in the orders migration shows one partition per month.'
  )
  await expect(orders.locator('[data-destination]')).toHaveText(
    'Notes › New note: Orders partitioning'
  )
  await expect(orders.locator('pre[data-suggestion-text]')).toHaveText(
    'The orders table is partitioned by month.\nQueries should filter on created_at to hit one partition.'
  )
  await expect(pricing.locator('[data-destination]')).toHaveText(
    'Notes › New note: Checkout pricing calls'
  )
  await expect(pricing.locator('pre[data-suggestion-text]')).toContainText(
    'Checkout calls the pricing service twice'
  )

  // Nothing was written to the group's knowledge.
  expect(knowledgeFiles(r.userDataDir)).toEqual(filesBefore)

  // Both tool calls were accepted by the bridge.
  const results = readFakeLog(r).filter(
    (l) => (l['mcpResult'] as { tool?: string } | undefined)?.tool === 'suggest_knowledge_update'
  )
  expect(results).toHaveLength(2)
  for (const l of results) {
    const res = l['mcpResult'] as { isError: boolean; text: string }
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.text)).toMatchObject({ ok: true })
  }

  // Discard one: the card leaves and the chip reads 1.
  await orders
    .getByRole('button', { name: 'Discard: Orders table is partitioned by month' })
    .click()
  await expect(cards).toHaveCount(1)
  await expect(orders).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  // The event history lists each suggestion and the discard.
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(2)
  await expect(eventRows(page, 'knowledge-suggested').first()).toContainText(
    'Notes › New note: Orders partitioning'
  )
  await expect(eventRows(page, 'knowledge-discarded')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-discarded')).toContainText(
    'Orders table is partitioned by month'
  )
  await expect(eventRows(page, 'knowledge-discarded')).toContainText('Discarded')

  // No notification, and no Needs attention badge or dot.
  expect(await notifications(app)).toEqual([])
  await expect(attentionBadge(page)).toHaveCount(0)
  await expect(
    page.getByRole('navigation', { name: 'Groups' }).locator('[data-attention-dot]')
  ).toHaveCount(0)

  // Quit and reopen on the same data: the discard held, one suggestion is still waiting.
  await r.relaunch()
  const page2 = r.page
  await page2
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page2.locator('[data-session-row]').first().click()
  await expect(chip(page2)).toBeVisible()
  await expect(chip(page2).locator('[data-count]')).toHaveText('1')
  await chip(page2).click()
  await expect(
    dialog(page2).locator('[data-knowledge-suggestions-list] [data-knowledge-suggestion]')
  ).toHaveCount(1)
  await expect(dialog(page2)).toContainText('Checkout calls pricing twice')
  await expect(dialog(page2)).not.toContainText('Orders table is partitioned by month')
  await page2.keyboard.press('Escape')

  // The history survived too, and the relaunch added no notification and no knowledge files.
  await expect(eventRows(page2, 'knowledge-suggested')).toHaveCount(2)
  await expect(eventRows(page2, 'knowledge-discarded')).toHaveCount(1)
  expect(await notifications(r.app)).toEqual([])
  await expect(attentionBadge(page2)).toHaveCount(0)
  expect(knowledgeFiles(r.userDataDir)).toEqual(filesBefore)
})

test('2.4: accepting a new-note suggestion writes the note, confirms it and Open lands on it', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  await chip(page).click()
  await orderCard(page)
    .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
    .click()

  // The card leaves, the chip counts one fewer and the confirmation names the destination.
  await expect(orderCard(page)).toHaveCount(0)
  const confirmation = dialog(page).locator('[data-knowledge-suggestion-confirmation]')
  await expect(confirmation).toHaveText(/Added to Notes › Orders partitioning/)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  // The file is in the group's Notes folder with exactly the suggested text.
  const files = knowledgeFiles(r.userDataDir)
  expect(files).toEqual(['Notes/Orders partitioning.md'])
  expect(readFileSync(join(appKnowledgeRoot(r.userDataDir), files[0]!), 'utf8')).toBe(ORDERS_TEXT)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-accepted')).toContainText('Accepted')

  // Open closes the dialog and shows the note, selected, with its text.
  await confirmation.getByRole('button', { name: 'Open: Orders partitioning' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true')
  const list = page.getByRole('list', { name: 'Items' })
  await expect(list.getByRole('button', { name: /Orders partitioning/ })).toBeVisible()
  await expect(page.locator('.cm-content')).toContainText(
    'The orders table is partitioned by month.'
  )
  await expect(page.locator('.cm-content')).toContainText('Queries should filter on created_at')

  // Back in the session, accepting the last card removes the chip and keeps the dialog open.
  await page.getByRole('tab', { name: 'Sessions' }).click()
  await expect(chip(page)).toBeVisible()
  await chip(page).click()
  await expect(pricingCard(page)).toBeVisible()
  await pricingCard(page)
    .getByRole('button', { name: 'Accept: Checkout calls pricing twice' })
    .click()
  await expect(chip(page)).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Notes › Checkout pricing calls/
  )
  await expect(dialog(page).locator('[data-knowledge-suggestions-empty]')).toHaveText(
    'No suggestions waiting.'
  )
  expect(knowledgeFiles(r.userDataDir).sort()).toEqual([
    'Notes/Checkout pricing calls.md',
    'Notes/Orders partitioning.md'
  ])
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
})

test('2.4: a taken name opens the editor on the name, leaves the existing note alone, and a new name saves the note', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)

  // A note with the suggested name appears after the suggestion was made.
  const notesDir = join(appKnowledgeRoot(r.userDataDir), 'Notes')
  mkdirSync(notesDir, { recursive: true })
  const existing = join(notesDir, 'Orders partitioning.md')
  writeFileSync(existing, 'My own notes on partitioning.')
  const before = knowledgeFiles(r.userDataDir)

  await chip(page).click()
  await orderCard(page)
    .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
    .click()

  // The editor opens straight away with focus in Name and the message under it; the card is not shown.
  await expect(editor(page)).toBeVisible()
  await expect(editor(page).getByRole('alert')).toHaveText('A note with this name already exists.')
  await expect(editor(page).getByLabel('Name')).toBeFocused()
  await expect(editor(page).getByLabel('Name')).toHaveValue('Orders partitioning')
  await expect(editor(page).getByLabel('Text')).toHaveValue(ORDERS_TEXT)
  await expect(orderCard(page).locator('[data-knowledge-suggestion-problem]')).toHaveCount(0)
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveCount(0)
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  expect(readFileSync(existing, 'utf8')).toBe('My own notes on partitioning.')
  expect(knowledgeFiles(r.userDataDir)).toEqual(before)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)

  // A new name saves the note under it and leaves the existing one untouched.
  await editor(page).getByLabel('Name').fill('Orders partitioning v2')
  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Notes › Orders partitioning v2/
  )
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  expect(readFileSync(existing, 'utf8')).toBe('My own notes on partitioning.')
  expect(readFileSync(join(notesDir, 'Orders partitioning v2.md'), 'utf8')).toBe(ORDERS_TEXT)
  expect(knowledgeFiles(r.userDataDir).sort()).toEqual([
    'Notes/Orders partitioning v2.md',
    'Notes/Orders partitioning.md'
  ])
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-accepted')).toContainText('Accepted after editing')
})

test('2.4: a linked folder that cannot be written shows "Couldn\'t save to", writes nothing, and Try again works once it is back', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page, app } = r
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'arc-ks-link-')))
  try {
    await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])

    // Link the group's knowledge to an empty folder.
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
    // A group with no knowledge yet links straight away, without the move dialog.
    await expect(panel.getByText(folder)).toBeVisible()
    await page.getByRole('tab', { name: 'Sessions' }).click()
    const linkedBefore = filesUnder(folder) // Arc's own link metadata

    await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
    await waitForTwoSuggestions(page)

    // The folder stops accepting writes while the dialog is open. Removing or renaming it would make Arc replace
    // the group view with "Knowledge folder not found" and close the dialog, so the folder is made read-only instead.
    await chip(page).click()
    await expect(orderCard(page)).toBeVisible()
    setWritable(folder, false)
    await orderCard(page)
      .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
      .click()

    const problem = orderCard(page).locator('[data-knowledge-suggestion-problem]')
    await expect(problem.getByRole('alert')).toContainText("Couldn't save to")
    await expect(problem.getByRole('alert')).toContainText(folder)
    await expect(problem.getByRole('button', { name: 'Try again' })).toBeVisible()
    await expect(chip(page).locator('[data-count]')).toHaveText('2')
    expect(filesUnder(folder)).toEqual(linkedBefore)
    expect(knowledgeFiles(r.userDataDir)).toEqual([])
    await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)

    // The folder is writable again: Try again saves into it.
    setWritable(folder, true)
    await problem.getByRole('button', { name: 'Try again' }).click()
    await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
      /Added to Notes › Orders partitioning/
    )
    expect(readFileSync(join(folder, 'Notes', 'Orders partitioning.md'), 'utf8')).toBe(ORDERS_TEXT)
    await expect(chip(page).locator('[data-count]')).toHaveText('1')
  } finally {
    setWritable(folder, true)
    rmSync(folder, { recursive: true, force: true })
  }
})

/**
 * Spec 011 slice 3: the brain suggests replacement edits to an existing note. The note is written into the group's
 * Notes folder before the session starts; front matter and several lines make "the rest unchanged" a real check.
 */
const SERVICE_MAP_FRONT = '---\ntitle: Service map\n---\n'
const SERVICE_MAP_BODY = [
  'The api service talks to the queue.',
  'Retries use a fixed delay of 30 seconds.',
  'Alerts go to the on-call channel.',
  'Deploys happen on weekdays only.',
  ''
].join('\n')
const SERVICE_MAP_RESULT = SERVICE_MAP_BODY.replace(
  'Retries use a fixed delay of 30 seconds.',
  'Retries use exponential backoff starting at 5 seconds.\nThe maximum is 5 attempts.'
)
const updateCard = (page: Page) =>
  dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Retries use exponential backoff'
  })

/** Writes the seeded note into the group's Notes folder and returns its path. */
function seedServiceMap(userDataDir: string): string {
  const notesDir = join(appKnowledgeRoot(userDataDir), 'Notes')
  mkdirSync(notesDir, { recursive: true })
  const path = join(notesDir, 'Service map.md')
  writeFileSync(path, SERVICE_MAP_FRONT + SERVICE_MAP_BODY)
  return path
}

async function startUpdateSession(r: Rig): Promise<string> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const path = seedServiceMap(r.userDataDir)
  await startSession(r.page, { request: 'How do retries work?', mode: 'Autonomous' })
  await expect(chip(r.page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(r.page).locator('[data-count]')).toHaveText('1')
  return path
}

test('2.4: accepting an update adds the new lines, removes the old one and leaves every other byte alone', async () => {
  const r = await launchRig({ scenario: 'ks-update', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startUpdateSession(r)
  const original = SERVICE_MAP_FRONT + SERVICE_MAP_BODY

  const results = readFakeLog(r).filter(
    (l) => (l['mcpResult'] as { tool?: string } | undefined)?.tool === 'suggest_knowledge_update'
  )
  expect(results).toHaveLength(1)
  const res = results[0]!['mcpResult'] as { isError: boolean; text: string }
  expect(res.isError).toBe(false)
  expect(JSON.parse(res.text)).toMatchObject({ ok: true })

  await chip(page).click()
  const card = updateCard(page)
  await expect(card).toHaveAttribute('data-kind', 'update')
  await expect(card.locator('[data-destination]')).toHaveText('Notes › Service map')
  const diff = card.getByRole('region', { name: 'Changes to Service map' })
  await expect(diff.locator('[data-diff-line="del"]')).toHaveCount(1)
  await expect(diff.locator('[data-diff-line="del"]')).toContainText(
    'Retries use a fixed delay of 30 seconds.'
  )
  await expect(diff.locator('[data-diff-line="add"]')).toHaveCount(2)
  await expect(diff.locator('[data-diff-line="add"]').first()).toContainText(
    'Retries use exponential backoff starting at 5 seconds.'
  )
  await expect(diff.locator('[data-diff-line="add"]').nth(1)).toContainText(
    'The maximum is 5 attempts.'
  )
  await expect(diff.locator('[data-diff-line="ctx"]').first()).toBeVisible()

  // Nothing is written before Accept.
  expect(readFileSync(path, 'utf8')).toBe(original)

  await card.getByRole('button', { name: 'Accept: Retries use exponential backoff' }).click()
  const confirmation = dialog(page).locator('[data-knowledge-suggestion-confirmation]')
  await expect(confirmation).toHaveText(/Added to Notes › Service map/)
  await expect(updateCard(page)).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)

  // Front matter and untouched lines are byte-identical; the edit is the only change.
  const after = readFileSync(path, 'utf8')
  expect(after).toBe(SERVICE_MAP_FRONT + SERVICE_MAP_RESULT)
  expect(after).not.toContain('fixed delay of 30 seconds')
  expect(after.startsWith(SERVICE_MAP_FRONT)).toBe(true)
  expect(knowledgeFiles(r.userDataDir)).toEqual(['Notes/Service map.md'])
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-accepted')).toContainText('Notes › Service map')
})

test('2.4: a note edited outside Arc refuses with "changed since", keeps the outside edit, and Show current and Discard work', async () => {
  const r = await launchRig({ scenario: 'ks-update', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startUpdateSession(r)

  const edited = SERVICE_MAP_FRONT + 'Rewritten by hand: retries are handled by the gateway.\n'
  writeFileSync(path, edited)

  await chip(page).click()
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Accept: Retries use exponential backoff' }).click()

  const problem = card.locator('[data-knowledge-suggestion-problem]')
  await expect(problem.getByRole('alert')).toHaveText(
    'This note has changed since the suggestion was made.'
  )
  await expect(card.getByRole('button', { name: 'Show current' })).toBeVisible()
  await expect(
    card.getByRole('button', { name: 'Discard: Retries use exponential backoff' })
  ).toBeVisible()
  await expect(card.getByRole('button', { name: /^Accept:/ })).toHaveCount(0)
  expect(readFileSync(path, 'utf8')).toBe(edited)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveCount(0)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)

  await card.getByRole('button', { name: 'Show current' }).click()
  await expect(card.locator('[data-current-note]')).toContainText(
    'Rewritten by hand: retries are handled by the gateway.'
  )

  await card.getByRole('button', { name: 'Discard: Retries use exponential backoff' }).click()
  await expect(updateCard(page)).toHaveCount(0)
  expect(readFileSync(path, 'utf8')).toBe(edited)
})

test('2.4: a deleted target says "no longer exists" and Add as a new note recreates it with the suggested text', async () => {
  const r = await launchRig({ scenario: 'ks-update', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startUpdateSession(r)

  rmSync(path)
  await chip(page).click()
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Accept: Retries use exponential backoff' }).click()

  const problem = card.locator('[data-knowledge-suggestion-problem]')
  await expect(problem.getByRole('alert')).toHaveText('This note no longer exists.')
  await expect(
    card.getByRole('button', { name: 'Discard: Retries use exponential backoff' })
  ).toBeVisible()
  await expect(card.getByRole('button', { name: /^Accept:/ })).toHaveCount(0)
  expect(existsSync(path)).toBe(false)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  // Add as a new note opens the editor seeded with the full proposed text, the old name and the section.
  await card.getByRole('button', { name: 'Add as a new note' }).click()
  await expect(editor(page)).toBeVisible()
  await expect(editor(page).getByLabel('Text')).toHaveValue(SERVICE_MAP_RESULT)
  await expect(editor(page).getByLabel('Name')).toHaveValue('Service map')
  await expect(editor(page).getByLabel('Section')).toHaveValue(/.+/)
  await expect(editor(page).getByLabel('Section').locator('option:checked')).toHaveText('Notes')
  expect(existsSync(path)).toBe(false)
  expect(knowledgeFiles(r.userDataDir)).toEqual([])
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Notes › Service map/
  )
  await expect(updateCard(page)).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)
  expect(knowledgeFiles(r.userDataDir)).toEqual(['Notes/Service map.md'])
  expect(readFileSync(path, 'utf8')).toBe(SERVICE_MAP_RESULT)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
})

/**
 * Spec 011 slice 4: Edit lets the user change the text, a new note's name and its section before accepting.
 */
const EDITED_TEXT = 'Orders are partitioned monthly.\nAlways filter on created_at.'

test('2.4/2.6: an edited new note is saved with the typed text, name and section and recorded as accepted after editing', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)

  await chip(page).click()
  const card = orderCard(page)
  await card.getByRole('button', { name: 'Edit: Orders table is partitioned by month' }).click()

  // Edit mode replaces the card's buttons with the editor's own Accept and Cancel.
  await expect(editor(page)).toHaveAttribute('role', 'group')
  await expect(editor(page).getByLabel('Text')).toHaveValue(ORDERS_TEXT)
  await expect(editor(page).getByLabel('Name')).toHaveValue('Orders partitioning')
  await expect(editor(page).getByLabel('Section').locator('option:checked')).toHaveText('Notes')
  await expect(editor(page).getByRole('button')).toHaveText(['Accept', 'Cancel'])
  await expect(card.getByRole('button', { name: /^Accept:/ })).toHaveCount(0)

  // Validation is inline and nothing is saved.
  await editor(page).getByLabel('Text').fill('')
  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(editor(page).getByRole('alert')).toHaveText('Enter some text.')
  await editor(page).getByLabel('Text').fill(EDITED_TEXT)
  await editor(page).getByLabel('Name').fill('')
  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(editor(page).getByRole('alert')).toHaveText('Enter a name.')
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  await editor(page).getByLabel('Name').fill('Monthly partitions')
  await editor(page).getByLabel('Section').selectOption({ label: 'Docs' })
  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()

  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Docs › Monthly partitions/
  )
  await expect(orderCard(page)).toHaveCount(0)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')

  // Saved in the chosen section under the new name with exactly the typed text; nothing under the suggested name.
  const files = knowledgeFiles(r.userDataDir)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^[^/]*Docs[^/]*\/Monthly partitions\.md$/i)
  expect(readFileSync(join(appKnowledgeRoot(r.userDataDir), files[0]!), 'utf8')).toBe(EDITED_TEXT)
  expect(files.some((f) => f.startsWith('Notes/') || f.includes('Orders partitioning'))).toBe(false)

  // The event history says so and names the edited destination.
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
  const row = eventRows(page, 'knowledge-accepted')
  await expect(row).toContainText('Accepted after editing')
  await expect(row).toContainText('Docs › New note: Monthly partitions')
  await expect(row).not.toContainText('Orders partitioning')
})

test('2.4: Edit then Cancel shows the original suggestion and saves nothing; Escape leaves edit mode before closing the dialog', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)
  const filesBefore = knowledgeFiles(r.userDataDir)

  await chip(page).click()
  const editButton = orderCard(page).getByRole('button', {
    name: 'Edit: Orders table is partitioned by month'
  })
  await editButton.click()
  await editor(page).getByLabel('Text').fill('Typed over the brain text.')
  await editor(page).getByLabel('Name').fill('Typed over name')
  await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click()

  // The card is back with the brain's text and destination, and nothing changed.
  await expect(editor(page)).toHaveCount(0)
  await expect(orderCard(page).locator('pre[data-suggestion-text]')).toHaveText(ORDERS_TEXT)
  await expect(orderCard(page).locator('[data-destination]')).toHaveText(
    'Notes › New note: Orders partitioning'
  )
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  expect(knowledgeFiles(r.userDataDir)).toEqual(filesBefore)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)
  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveCount(0)

  // Opening Edit again starts from the original, not the discarded typing.
  await editButton.click()
  await expect(editor(page).getByLabel('Text')).toHaveValue(ORDERS_TEXT)
  await expect(editor(page).getByLabel('Name')).toHaveValue('Orders partitioning')

  // First Escape closes the editor only; the second closes the dialog.
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  await expect(orderCard(page).locator('pre[data-suggestion-text]')).toHaveText(ORDERS_TEXT)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  expect(knowledgeFiles(r.userDataDir)).toEqual(filesBefore)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)
})

test('2.4: editing an update loads the full text, and Accept saves the typed body under the seeded front matter', async () => {
  const r = await launchRig({ scenario: 'ks-update', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startUpdateSession(r)

  await chip(page).click()
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Edit: Retries use exponential backoff' }).click()
  await expect(editor(page)).toBeVisible()
  await expect(dialog(page).locator('[data-knowledge-suggestion-loading]')).toHaveCount(0)
  // An update has no Name or Section fields.
  await expect(editor(page).getByLabel('Name')).toHaveCount(0)
  await expect(editor(page).getByLabel('Section')).toHaveCount(0)
  const text = editor(page).getByLabel('Text')
  // The editor shows the body; the note's front matter is kept by the save.
  await expect(text).toHaveValue(SERVICE_MAP_RESULT)

  const typedBody = SERVICE_MAP_RESULT.replace('5 attempts', '3 attempts')
  await text.fill(typedBody)
  await editor(page).getByRole('button', { name: 'Accept', exact: true }).click()

  await expect(dialog(page).locator('[data-knowledge-suggestion-confirmation]')).toHaveText(
    /Added to Notes › Service map/
  )
  await expect(chip(page)).toHaveCount(0)
  const after = readFileSync(path, 'utf8')
  expect(after).toBe(SERVICE_MAP_FRONT + typedBody)
  expect(after.startsWith(SERVICE_MAP_FRONT)).toBe(true)
  expect(knowledgeFiles(r.userDataDir)).toEqual(['Notes/Service map.md'])
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(1)
  await expect(eventRows(page, 'knowledge-accepted')).toContainText('Accepted after editing')
})

/**
 * Spec 011 slice 5: Accept all and Discard all, and the dialog driven with the keyboard alone. `ks-three` suggests two
 * new notes and one update to the seeded "Service map" note.
 */
const footer = (page: Page) => dialog(page).locator('[data-knowledge-suggestions-footer]')
const live = (page: Page) => dialog(page).locator('[data-knowledge-suggestions-live]')
const confirmations = (page: Page) =>
  dialog(page).locator('[data-knowledge-suggestion-confirmation]')
const cardsIn = (page: Page) =>
  dialog(page).locator('[data-knowledge-suggestions-list] [data-knowledge-suggestion]')

async function startThreeSession(r: Rig): Promise<string> {
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  const path = seedServiceMap(r.userDataDir)
  await startSession(r.page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await expect(chip(r.page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(r.page)).toContainText('Suggestions')
  await expect(chip(r.page).locator('[data-count]')).toHaveText('3')
  return path
}

/** The accessible name of the focused element: its aria-label, else its text. */
async function focusedName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (!el) return ''
    return el.getAttribute('aria-label') ?? (el.textContent ?? '').trim()
  })
}

test('2.4: Accept all applies two new notes and an update, keeps the dialog open with three confirmations and clears the chip', async () => {
  const r = await launchRig({ scenario: 'ks-three', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startThreeSession(r)
  const original = SERVICE_MAP_FRONT + SERVICE_MAP_BODY

  await chip(page).click()
  await expect(cardsIn(page)).toHaveCount(3)
  await expect(live(page)).toHaveText('3 suggestions waiting')
  expect(knowledgeFiles(r.userDataDir)).toEqual(['Notes/Service map.md'])
  expect(readFileSync(path, 'utf8')).toBe(original)

  await footer(page).getByRole('button', { name: 'Accept all' }).click()

  // Three confirmations, no cards, and the dialog stays open.
  await expect(confirmations(page)).toHaveCount(3)
  await expect(cardsIn(page)).toHaveCount(0)
  await expect(dialog(page).locator('[data-knowledge-suggestions-empty]')).toHaveText(
    'No suggestions waiting.'
  )
  await expect(live(page)).toHaveText('No suggestions waiting')
  await expect(chip(page)).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  await expect(footer(page).getByRole('button', { name: 'Accept all' })).toHaveCount(0)
  await expect(footer(page).getByRole('button', { name: 'Discard all' })).toHaveCount(0)
  await expect(dialog(page).locator('[data-knowledge-suggestion-problem]')).toHaveCount(0)
  for (const text of [
    /Added to Notes › Orders partitioning/,
    /Added to Notes › Checkout pricing calls/,
    /Added to Notes › Service map/
  ]) {
    await expect(confirmations(page).filter({ hasText: text })).toHaveCount(1)
  }

  // Both new files carry the suggested text; the update kept its front matter and untouched lines.
  expect(knowledgeFiles(r.userDataDir).sort()).toEqual([
    'Notes/Checkout pricing calls.md',
    'Notes/Orders partitioning.md',
    'Notes/Service map.md'
  ])
  const root = appKnowledgeRoot(r.userDataDir)
  expect(readFileSync(join(root, 'Notes/Orders partitioning.md'), 'utf8')).toBe(ORDERS_TEXT)
  expect(readFileSync(join(root, 'Notes/Checkout pricing calls.md'), 'utf8')).toBe(
    'Checkout calls the pricing service twice: once for the cart total and once at payment.'
  )
  const after = readFileSync(path, 'utf8')
  expect(after).toBe(SERVICE_MAP_FRONT + SERVICE_MAP_RESULT)
  expect(after.startsWith(SERVICE_MAP_FRONT)).toBe(true)

  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(3)
  await expect(eventRows(page, 'knowledge-discarded')).toHaveCount(0)

  await footer(page).getByRole('button', { name: 'Close' }).click()
  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)
})

test('2.4: Discard all asks first, Keep leaves everything, and Discard clears the list without touching the knowledge folder', async () => {
  const r = await launchRig({ scenario: 'ks-three', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startThreeSession(r)
  const filesBefore = knowledgeFiles(r.userDataDir)
  const bytesBefore = readFileSync(path)

  await chip(page).click()
  await expect(cardsIn(page)).toHaveCount(3)
  await expect(footer(page).getByRole('button', { name: 'Discard all' })).toBeVisible()
  await footer(page).getByRole('button', { name: 'Discard all' }).click()

  // The footer asks once, with focus on Keep; nothing is discarded yet.
  await expect(footer(page)).toContainText('Discard all 3 suggestions?')
  await expect(footer(page).getByRole('button')).toHaveText(['Discard', 'Keep'])
  await expect(footer(page).getByRole('button', { name: 'Keep' })).toBeFocused()
  await expect(cardsIn(page)).toHaveCount(3)

  // Keep returns to the original footer with all three cards in place.
  await footer(page).getByRole('button', { name: 'Keep' }).click()
  await expect(cardsIn(page)).toHaveCount(3)
  await expect(footer(page)).not.toContainText('Discard all 3 suggestions?')
  await expect(footer(page).getByRole('button')).toHaveText(['Accept all', 'Discard all', 'Close'])
  await expect(chip(page).locator('[data-count]')).toHaveText('3')
  await expect(eventRows(page, 'knowledge-discarded')).toHaveCount(0)

  // Ask again and confirm.
  await footer(page).getByRole('button', { name: 'Discard all' }).click()
  await expect(footer(page)).toContainText('Discard all 3 suggestions?')
  await footer(page).getByRole('button', { name: 'Discard', exact: true }).click()

  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)
  expect(knowledgeFiles(r.userDataDir)).toEqual(filesBefore)
  expect(readFileSync(path).equals(bytesBefore)).toBe(true)
  await expect(eventRows(page, 'knowledge-discarded')).toHaveCount(3)
  await expect(eventRows(page, 'knowledge-discarded').first()).toContainText('Discarded')
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(0)
})

test('2.4: Accept all with one name taken applies the other two, leaves "Suggestions 1" and opens the name-taken state', async () => {
  const r = await launchRig({ scenario: 'ks-three', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const path = await startThreeSession(r)

  // The orders note's name is taken after the suggestion was made.
  const existing = join(appKnowledgeRoot(r.userDataDir), 'Notes', 'Orders partitioning.md')
  writeFileSync(existing, 'My own notes on partitioning.')

  await chip(page).click()
  await footer(page).getByRole('button', { name: 'Accept all' }).click()

  await expect(confirmations(page)).toHaveCount(2)
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await expect(live(page)).toHaveText('1 suggestion waiting')
  await expect(cardsIn(page)).toHaveCount(1)
  await expect(orderCard(page)).toHaveCount(1)
  await expect(editor(page)).toBeVisible()
  await expect(editor(page).getByRole('alert')).toHaveText('A note with this name already exists.')
  await expect(editor(page).getByLabel('Name')).toBeFocused()

  expect(readFileSync(existing, 'utf8')).toBe('My own notes on partitioning.')
  expect(
    readFileSync(join(appKnowledgeRoot(r.userDataDir), 'Notes/Checkout pricing calls.md'), 'utf8')
  ).toBe('Checkout calls the pricing service twice: once for the cart total and once at payment.')
  expect(readFileSync(path, 'utf8')).toBe(SERVICE_MAP_FRONT + SERVICE_MAP_RESULT)
  await expect(eventRows(page, 'knowledge-accepted')).toHaveCount(2)
})

test('2.3: the dialog works with the keyboard alone, including Escape, and the live region follows the count', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)
  const filesBefore = knowledgeFiles(r.userDataDir)
  const tab = async (): Promise<string> => {
    await page.keyboard.press('Tab')
    const name = await focusedName(page)
    return name
  }

  // Focus the chip, then no mouse: Enter opens the dialog.
  await chip(page).focus()
  await page.keyboard.press('Enter')
  await expect(dialog(page)).toBeVisible()
  expect(await focusedName(page)).toBe('Accept: Checkout calls pricing twice')

  // Newest first: the pricing card, then the orders card. Walk from the first card's Accept.
  const first = 'Checkout calls pricing twice'
  const second = 'Orders table is partitioned by month'
  await dialog(page)
    .getByRole('button', { name: `Accept: ${first}` })
    .focus()
  expect(await focusedName(page)).toBe(`Accept: ${first}`)
  expect(await tab()).toBe(`Edit: ${first}`)
  expect(await tab()).toBe(`Discard: ${first}`)
  expect(await tab()).toBe(`Accept: ${second}`)
  expect(await tab()).toBe(`Edit: ${second}`)
  expect(await tab()).toBe(`Discard: ${second}`)
  expect(await tab()).toBe('Accept all')
  expect(await tab()).toBe('Discard all')
  expect(await tab()).toBe('Close')

  // Edit with Enter, Escape leaves edit mode and keeps the dialog.
  await dialog(page)
    .getByRole('button', { name: `Edit: ${first}` })
    .focus()
  await page.keyboard.press('Enter')
  await expect(editor(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editor(page)).toHaveCount(0)
  await expect(dialog(page)).toBeVisible()
  expect(await focusedName(page)).toBe(`Edit: ${first}`)

  // Discard all with Enter: focus is on Keep; Escape cancels the confirmation only.
  await dialog(page).getByRole('button', { name: 'Close' }).focus()
  await page.keyboard.press('Shift+Tab')
  expect(await focusedName(page)).toBe('Discard all')
  await page.keyboard.press('Enter')
  await expect(footer(page)).toContainText('Discard all 2 suggestions?')
  await expect(footer(page).getByRole('button', { name: 'Keep' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(footer(page)).not.toContainText('Discard all 2 suggestions?')
  await expect(dialog(page)).toBeVisible()
  await expect(cardsIn(page)).toHaveCount(2)
  await expect(footer(page).getByRole('button', { name: 'Discard all' })).toBeFocused()

  // Accept the first card from its Accept button with Enter.
  await dialog(page)
    .getByRole('button', { name: `Accept: ${first}` })
    .focus()
  await page.keyboard.press('Enter')
  await expect(confirmations(page)).toHaveCount(1)
  await expect(cardsIn(page)).toHaveCount(1)
  await expect(live(page)).toHaveText('1 suggestion waiting')
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await expect(page.getByRole('button', { name: `Accept: ${second}` })).toBeFocused()
  expect(knowledgeFiles(r.userDataDir)).toEqual(['Notes/Checkout pricing calls.md'])
  expect(knowledgeFiles(r.userDataDir)).not.toEqual(filesBefore)

  // Tab reaches the confirmation's Open button.
  const reached: string[] = []
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    reached.push(await focusedName(page))
  }
  expect(reached).toContain('Open: Checkout pricing calls')

  // Escape closes the dialog; the Modal returns focus to the chip that opened it.
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page)).toBeFocused()
})

/**
 * Spec 011 slice 6: at most 5 suggestions per request, never the same one twice, none while workers run, and the
 * line under the brain's answer that opens the dialog.
 */
const SUGGEST_TOOL = 'suggest_knowledge_update'

/** The results of the brain's `suggest_knowledge_update` calls, in order, from the fake CLI log. */
function suggestResults(r: Rig): { isError: boolean; text: string }[] {
  return readFakeLog(r)
    .map((l) => l['mcpResult'] as { tool?: string; isError: boolean; text: string } | undefined)
    .filter((m): m is { tool: string; isError: boolean; text: string } => m?.tool === SUGGEST_TOOL)
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

const suggestionsLine = (page: Page) => page.locator('[data-knowledge-suggestions-line]')

async function sendToBrain(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder('Message the brain')
  await box.fill(text)
  await box.press('Enter')
}

test('2.1: a sixth suggestion in one request is refused with cap_reached, and the next request starts the count again', async () => {
  const r = await launchRig({ scenario: 'ks-cap', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, {
    request: 'What do you know about the queue client?',
    mode: 'Autonomous'
  })

  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('5')
  await expect(chip(page)).toContainText('Suggestions')
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(5)
  await expect(suggestionsLine(page)).toHaveText("I have 5 suggestions for this group's knowledge.")

  // Five were stored and the sixth was refused by the main process.
  const first = suggestResults(r)
  expect(first).toHaveLength(6)
  for (const res of first.slice(0, 5)) {
    expect(res.isError).toBe(false)
    expect(JSON.parse(res.text)).toMatchObject({ ok: true })
  }
  expect(first[4]!.text).toContain('"remainingThisRequest":0')
  expect(first[5]!.isError).toBe(true)
  expect(first[5]!.text).toContain('cap_reached')
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  // A new user message is a new request: one more suggestion is accepted.
  await sendToBrain(page, 'ANOTHER-ASK: anything else about the queue client?')
  await expect(chip(page).locator('[data-count]')).toHaveText('6', { timeout: 20_000 })
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(6)
  const all = suggestResults(r)
  expect(all).toHaveLength(7)
  expect(all[6]!.isError).toBe(false)
  expect(JSON.parse(all[6]!.text)).toMatchObject({ ok: true, remainingThisRequest: 4 })
})

test('2.1: a discarded suggestion is refused with already_discarded in a later request, and the brain is told', async () => {
  const r = await launchRig({ scenario: 'ks-discarded', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })

  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await chip(page).click()
  await orderCard(page)
    .getByRole('button', { name: 'Discard: Orders table is partitioned by month' })
    .click()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(chip(page)).toHaveCount(0)

  // The next request: the brain suggests the same note again.
  await sendToBrain(page, 'ANOTHER-ASK: anything else about orders?')
  await expect.poll(() => suggestResults(r).length, { timeout: 20_000 }).toBe(2)
  const results = suggestResults(r)
  expect(results[0]!.isError).toBe(false)
  expect(results[1]!.isError).toBe(true)
  expect(results[1]!.text).toContain('already_discarded')

  // Nothing came back: no chip, no new event, no file.
  await expect(chip(page)).toHaveCount(0)
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(1)
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  // The message the brain received for the second request starts with the discard note naming the title.
  const second = receivedUserTexts(r).find((t) => t.includes('ANOTHER-ASK'))
  expect(second).toBeDefined()
  expect(second).toMatch(
    /^\[Arc\] The user discarded these knowledge suggestions: "Orders table is partitioned by month"\. Don't suggest them again\./
  )
})

test('2.1: while a worker runs the tool refuses with workers_running unless the user asked; after the merge a plain call works', async () => {
  const r = await launchRig({ scenario: 'ks-workers', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Add a retry file to the API client', mode: 'Autonomous' })

  // The brain's two calls happen right after the spawn, while the worker is still working.
  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  let results = suggestResults(r)
  expect(results).toHaveLength(2)
  expect(results[0]!.isError).toBe(true)
  expect(results[0]!.text).toContain('workers_running')
  expect(results[1]!.isError).toBe(false)
  expect(JSON.parse(results[1]!.text)).toMatchObject({ ok: true })

  // Once the worker is done and merged, a plain call is accepted.
  await expect.poll(() => suggestResults(r).length, { timeout: 40_000 }).toBe(3)
  results = suggestResults(r)
  expect(results[2]!.isError).toBe(false)
  expect(JSON.parse(results[2]!.text)).toMatchObject({ ok: true })
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(2)
})

test("2.3: the brain's answer ends with a line that opens the dialog, and it stays as plain text once nothing waits, also after a restart", async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)

  // The line is a button under the brain's reply, and it opens the same dialog as the chip.
  const line = page.getByRole('button', {
    name: "I have 2 suggestions for this group's knowledge."
  })
  await expect(line).toBeVisible()
  await expect(suggestionsLine(page)).toHaveCount(1)
  await line.click()
  await expect(dialog(page)).toBeVisible()
  await expect(cardsIn(page)).toHaveCount(2)

  // Accept one and discard the other: nothing waits, the line is plain text (no button), the chip is gone.
  await orderCard(page)
    .getByRole('button', { name: 'Accept: Orders table is partitioned by month' })
    .click()
  await pricingCard(page)
    .getByRole('button', { name: 'Discard: Checkout calls pricing twice' })
    .click()
  await expect(chip(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)
  await expect(suggestionsLine(page)).toHaveText("I have 2 suggestions for this group's knowledge.")
  await expect(page.locator('button[data-knowledge-suggestions-line]')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: "I have 2 suggestions for this group's knowledge." })
  ).toHaveCount(0)

  // After quitting and reopening, the line is still under that reply, still plain text.
  await r.relaunch()
  const page2 = r.page
  await page2
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page2.locator('[data-session-row]').first().click()
  await expect(suggestionsLine(page2)).toHaveText(
    "I have 2 suggestions for this group's knowledge."
  )
  await expect(page2.locator('button[data-knowledge-suggestions-line]')).toHaveCount(0)
  await expect(chip(page2)).toHaveCount(0)
})

/**
 * Spec 011 slice 7: the "Suggest knowledge updates" switch in Settings > Knowledge.
 */
const suggestSwitch = (page: Page) =>
  page.getByRole('switch', { name: 'Suggest knowledge updates' })

/** Opens Settings > Knowledge from wherever the app is. */
async function openKnowledgeSettings(page: Page): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Knowledge' })
    .click()
  await expect(page.locator('[data-knowledge-settings]')).toBeVisible()
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-settings]')).toHaveCount(0)
}

/** Flips the switch in Settings and waits until the stored value follows. */
async function setSuggestSwitch(page: Page, on: boolean): Promise<void> {
  await openKnowledgeSettings(page)
  if (on) await suggestSwitch(page).check()
  else await suggestSwitch(page).uncheck()
  await expect(suggestSwitch(page)).toBeChecked({ checked: on })
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const result = await (
          window as unknown as {
            arc: {
              invoke(c: string, r: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }>
            }
          }
        ).arc.invoke('settings:get', {})
        return result.data['knowledge.suggestOnFinish']
      })
    )
    .toBe(on)
}

/** The system prompt each brain start of the fake CLI received. */
function brainPrompts(r: Rig): string[] {
  return sessionStarts(readFakeLog(r))
    .map((argv) => flag(argv, '--append-system-prompt') ?? '')
    .filter((prompt) => prompt.includes('arc-role:brain'))
}

const OFF_WORDING = 'Knowledge suggestions are switched off: do not call'
const ON_WORDING = 'you may call'

test('2.5: with the switch off a finishing brain is refused with suggestions_off, nothing appears or is written, and the prompt says so', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  // On by default; switch it off in Settings > Knowledge and go back.
  await openKnowledgeSettings(page)
  await expect(suggestSwitch(page)).toBeChecked()
  await setSuggestSwitch(page, false)
  await closeSettings(page)

  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })

  // Both plain calls came back refused.
  await expect.poll(() => suggestResults(r).length, { timeout: 20_000 }).toBe(2)
  for (const result of suggestResults(r)) {
    expect(result.isError).toBe(true)
    expect(result.text).toContain('suggestions_off')
  }
  // The reply is there, but there is no chip, no event, no line and no file.
  await expect(page.getByText('The orders table is partitioned by month').first()).toBeVisible()
  await expect(chip(page)).toHaveCount(0)
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(0)
  await expect(suggestionsLine(page)).toHaveCount(0)
  expect(knowledgeFiles(r.userDataDir)).toEqual([])

  // The brain was started with the "off" wording and without the invitation.
  const prompts = brainPrompts(r)
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain(OFF_WORDING)
  expect(prompts[0]).not.toContain(ON_WORDING)
})

test('2.5: with the switch off a suggestion the user asked for is still stored and shown', async () => {
  const r = await launchRig({ scenario: 'ks-asked', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await setSuggestSwitch(page, false)
  await closeSettings(page)
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What should we add to the knowledge?', mode: 'Autonomous' })

  await expect(chip(page)).toBeVisible({ timeout: 20_000 })
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await expect(chip(page)).toContainText('Suggestions')
  const results = suggestResults(r)
  expect(results).toHaveLength(1)
  expect(results[0]!.isError).toBe(false)
  expect(JSON.parse(results[0]!.text)).toMatchObject({ ok: true })
  expect(brainPrompts(r)[0]).toContain(OFF_WORDING)
})

test('2.5: switching off keeps the waiting suggestions, tells the running brain, and refuses its next plain call', async () => {
  const r = await launchRig({ scenario: 'ks-switch', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)
  expect(brainPrompts(r)[0]).toContain(ON_WORDING)

  // Switch off while the brain runs, then come back to the session.
  await setSuggestSwitch(page, false)
  await closeSettings(page)
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  await chip(page).click()
  await expect(cardsIn(page)).toHaveCount(2)
  await expect(orderCard(page)).toBeVisible()
  await expect(pricingCard(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog(page)).toHaveCount(0)

  // The next message carries the note, and the plain call in that turn is refused.
  await sendToBrain(page, 'SECOND-ASK: anything else about checkout?')
  await expect.poll(() => suggestResults(r).length, { timeout: 20_000 }).toBe(3)
  const results = suggestResults(r)
  expect(results[2]!.isError).toBe(true)
  expect(results[2]!.text).toContain('suggestions_off')
  const second = receivedUserTexts(r).find((t) => t.includes('SECOND-ASK'))
  expect(second).toBeDefined()
  expect(second).toMatch(
    /^\[Arc\] The user switched knowledge suggestions off\. Don't suggest knowledge updates on your own; only when they ask\./
  )
  await expect(chip(page).locator('[data-count]')).toHaveText('2')
  await expect(eventRows(page, 'knowledge-suggested')).toHaveCount(2)
})

test('2.5: the switch stays off after a relaunch, and switching it on again lets a new brain suggest', async () => {
  const r = await launchRig({ scenario: 'ks-two-new', repos: [{ name: 'api' }] })
  rig = r
  await setSuggestSwitch(r.page, false)
  await r.relaunch()
  const { page } = r
  await openKnowledgeSettings(page)
  await expect(suggestSwitch(page)).not.toBeChecked()

  await setSuggestSwitch(page, true)
  await closeSettings(page)
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await waitForTwoSuggestions(page)
  const prompts = brainPrompts(r)
  expect(prompts[prompts.length - 1]).toContain(ON_WORDING)
  expect(prompts[prompts.length - 1]).not.toContain(OFF_WORDING)
})
