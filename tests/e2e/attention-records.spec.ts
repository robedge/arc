// @spec: 014-inline-needs-attention
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  sendToBrain,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig, RepoKind } from './sessions-rig'
import {
  alwaysAllow,
  answerQuestion,
  approve,
  chooseForBranch,
  deny,
  expectNoneWaiting,
  expectWaiting,
  pendingAction,
  request,
  requests
} from './attention-rig'

/**
 * Spec 014 slice 6: an answered request leaves one quiet line in the conversation, kept with the session's history.
 * The line is a `[data-record]` paragraph with the decision in `data-record-decision` and the full text in `title`.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

interface SetupOptions {
  repos?: { name: string; kind?: RepoKind }[]
}

async function setup(scenario: string, options: SetupOptions = {}): Promise<Rig> {
  const repos = options.repos ?? [{ name: 'api' }]
  const r = await launchRig({ scenario, repos })
  rig = r
  await createGroupWithProjects(
    r,
    'Storefront',
    repos.map((repo) => r.repos[repo.name]!)
  )
  return r
}

const conversation = (page: Page): Locator => page.getByRole('log', { name: 'Conversation' })
const records = (page: Page): Locator => conversation(page).locator('[data-record]')

interface Entry {
  record: boolean
  decision: string | null
  text: string
}

/** Every message and record of the conversation, in the order they are drawn. */
async function entries(page: Page): Promise<Entry[]> {
  return conversation(page)
    .locator('[data-message-role], [data-record]')
    .evaluateAll((els) =>
      els.map((el) => ({
        record: el.hasAttribute('data-record'),
        decision: el.getAttribute('data-record-decision'),
        text: el.hasAttribute('data-record')
          ? (el.getAttribute('title') ?? '')
          : (el as HTMLElement).innerText.trim()
      }))
    )
}

/** Opens the session again after a relaunch. */
async function reopenSession(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
}

const PUSH = 'git push origin arc/records'
const QUESTION = 'Should the retry count be configurable?'

test('8.1: approving a command leaves "Approved: <command> (<from>)" as the last entry of the conversation', async () => {
  const r = await setup('attention-records')
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await sendToBrain(page, 'Start the api worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  expect(await pendingAction(page)).toBe(PUSH)
  await expect(records(page)).toHaveCount(0)

  await approve(request(page, 'permission'))
  await expectNoneWaiting(page)

  const record = records(page)
  await expect(record).toHaveCount(1)
  await expect(record).toHaveAttribute('data-record-decision', 'approved')
  await expect(record).toHaveText(`Approved: ${PUSH} (W1 api-retry)`)
  await expect(page.locator('[data-record-decision="approved"]')).toHaveCount(1)
  // Nothing else follows it.
  const all = await entries(page)
  expect(all[all.length - 1]).toMatchObject({
    record: true,
    decision: 'approved',
    text: `Approved: ${PUSH} (W1 api-retry)`
  })
})

test('8.2: answering a brain question leaves "Answered: <question> → <answer> (Brain)"', async () => {
  const r = await setup('attention-ask-user')
  const { page } = r
  await startSession(page, { request: 'Retry count', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  await answerQuestion(request(page, 'question'), 'Yes, make it configurable')
  await expectNoneWaiting(page)

  const record = records(page)
  await expect(record).toHaveCount(1)
  await expect(record).toHaveAttribute('data-record-decision', 'answered')
  await expect(record).toHaveText(`Answered: ${QUESTION} → Yes, make it configurable (Brain)`)
})

test('8.3: choosing "Set aside" for unsaved changes leaves "Unsaved changes in <project>: Set aside (Arc)" as the last entry', async () => {
  const r = await setup('spec-013-web-first', {
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty-no-dev' }
    ]
  })
  const { page } = r
  await startSession(page, { request: 'Why is the orders report slow?', mode: 'Autonomous' })
  await expect(page.locator('[data-session-name]')).toHaveText('Retry work')
  await sendToBrain(page, 'Start the web worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await chooseForBranch(requests(page, 'branch'), 'Set aside')
  await expectNoneWaiting(page)
  await expect(workerCard(page, 'W1 · web-note')).toHaveAttribute('data-worker-card', 'working', {
    timeout: 30_000
  })

  const record = records(page)
  await expect(record).toHaveCount(1)
  await expect(record).toHaveAttribute('data-record-decision', 'branch')
  await expect(record).toHaveText('Unsaved changes in web: Set aside (Arc)')
  const all = await entries(page)
  expect(all[all.length - 1]).toMatchObject({
    record: true,
    text: 'Unsaved changes in web: Set aside (Arc)'
  })
})

test('8.4a: Deny leaves "Denied: <command> (<from>)"', async () => {
  const r = await setup('attention-brew')
  const { page } = r
  await startSession(page, { request: 'Add jq tooling', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)

  await expect(page.locator('[data-record-decision="denied"]')).toHaveText(
    'Denied: brew install jq (W1 tooling)'
  )
  await expect(records(page)).toHaveCount(1)
})

test('8.4b: "Always allow this in this session" leaves one "Always allowed in this session" record even when it clears another waiting request', async () => {
  const r = await setup('rules-two')
  const { page } = r
  await startSession(page, { request: 'Two writers', mode: 'Autonomous' })
  await expectWaiting(page, 2, { timeout: 30_000 })
  const command = await pendingAction(page)
  expect(command).toMatch(/^cp a\.txt \/Users\/redgell\/v9-outside\/z-(one|two)\.txt$/)
  await alwaysAllow(request(page, 'permission'))
  // The rule also covers the second writer's request, so both leave the dock.
  await expectNoneWaiting(page)

  const record = records(page)
  await expect(record).toHaveCount(1)
  await expect(record).toHaveAttribute('data-record-decision', 'always')
  await expect(record).toHaveText(
    new RegExp(
      `^Always allowed in this session: ${command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(W[12] writer-(one|two)\\)$`
    )
  )
  // Give a stray second record time to appear.
  await page.waitForTimeout(1000)
  await expect(records(page)).toHaveCount(1)
})

test('8.5: a brain message that arrives after a record appears below it, and the earlier ones stay above', async () => {
  const r = await setup('attention-ask-user')
  const { page } = r
  await startSession(page, { request: 'Retry count', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  await answerQuestion(request(page, 'question'), 'Yes')
  await expect(page.getByText('Thanks, noted.')).toBeVisible()

  const all = await entries(page)
  const earlier = all.findIndex((e) => !e.record && e.text.includes('I need one decision first.'))
  const record = all.findIndex((e) => e.record)
  const later = all.findIndex((e) => !e.record && e.text.includes('Thanks, noted.'))
  expect(earlier).toBeGreaterThanOrEqual(0)
  expect(record).toBeGreaterThan(earlier)
  expect(later).toBeGreaterThan(record)
  expect(all[record]!.text).toBe(`Answered: ${QUESTION} → Yes (Brain)`)
})

test('8.6: after quitting and relaunching Arc, the records are still there with the same texts and places', async () => {
  const r = await setup('attention-records', {
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty-no-dev' }
    ]
  })
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()

  await sendToBrain(page, 'Start the api worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await approve(request(page, 'permission'))
  await expectNoneWaiting(page)
  await expect(records(page)).toHaveCount(1)

  await sendToBrain(page, 'Ask me something')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await answerQuestion(request(page, 'question'), 'Yes')
  await expectNoneWaiting(page)
  await expect(page.getByText('Thanks, noted.')).toBeVisible()

  await sendToBrain(page, 'Start the web worker')
  await expectWaiting(page, 1, { timeout: 30_000 })
  await chooseForBranch(requests(page, 'branch'), 'Set aside')
  await expectNoneWaiting(page)
  // The line is written at the click, so it is there without waiting for the worker.
  await expect(page.locator('[data-record-decision="branch"]')).toHaveCount(1)

  await sendToBrain(page, 'Say one more thing')
  await expect(page.getByText('One more thing from the brain.')).toBeVisible({ timeout: 30_000 })
  await expect(records(page)).toHaveCount(3)

  const before = await entries(page)
  const texts = before.filter((e) => e.record).map((e) => e.text)
  expect(texts).toEqual([
    `Approved: ${PUSH} (W1 api-retry)`,
    `Answered: ${QUESTION} → Yes (Brain)`,
    'Unsaved changes in web: Set aside (Arc)'
  ])
  // The later brain message is below the last record.
  expect(before.findLastIndex((e) => e.record)).toBeLessThan(
    before.findIndex((e) => e.text.includes('One more thing from the brain.'))
  )

  await r.relaunch()
  await reopenSession(r.page)
  await expect(records(r.page)).toHaveCount(3)
  const after = await entries(r.page)
  expect(after.filter((e) => e.record).map((e) => e.text)).toEqual(texts)
  // Same places relative to the messages: compare the whole sequence (messages by their text).
  const shape = (list: Entry[]): string[] =>
    list.map((e) => (e.record ? `record:${e.text}` : `message:${e.text.slice(0, 40)}`))
  // Arc adds its own notice about the workers it stopped on quit after the history; nothing else changed.
  expect(shape(after.slice(0, before.length))).toEqual(shape(before))
  expect(after.slice(before.length).every((e) => !e.record)).toBe(true)
  await expect(r.page.locator('[data-record-decision="approved"]')).toHaveCount(1)
  await expect(r.page.locator('[data-record-decision="answered"]')).toHaveCount(1)
  await expect(r.page.locator('[data-record-decision="branch"]')).toHaveCount(1)
})

test("8.7: a request answered in a stepped-in worker's terminal bar leaves no record in the conversation", async () => {
  const r = await setup('step-in-push')
  const { page } = r
  const W1 = 'W1 · api-retry'
  await startSession(page, { request: 'Add retry then push', mode: 'Autonomous' })
  await expect(workerCard(page, W1)).toHaveAttribute('data-worker-card', 'working')
  await workerCard(page, W1).getByRole('button').first().click()
  await page.getByRole('button', { name: 'Step in', exact: true }).click()
  const input = page.getByLabel(`Message to ${W1}`)
  await input.fill('Please push the branch')
  await input.press('Enter')

  const pinned = page.getByRole('group', { name: 'Needs your answer' })
  await expect(pinned.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await pinned.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(() =>
      readFakeLog(r)
        .filter((l) => 'permission' in l)
        .map((l) => (l['permission'] as { behavior: string }).behavior)
    )
    .toEqual(['allow'])
  await expect(pinned).toHaveCount(0)
  await page.waitForTimeout(1000)

  // Back on the Brain tab: the conversation has no record.
  await page
    .getByRole('tablist', { name: 'Conversation' })
    .getByRole('tab', { name: /^Brain/ })
    .click()
  await expect(page.getByText('The worker is running.')).toBeVisible()
  await expect(page.locator('[data-record]')).toHaveCount(0)
})

test('8.8: a 300 character command is one truncated line whose title holds the full text', async () => {
  const r = await setup('attention-records-long')
  const { page } = r
  await startSession(page, { request: 'Push the branch', mode: 'Autonomous' })
  await expectWaiting(page, 1, { timeout: 30_000 })
  const command = await pendingAction(page)
  expect(command).toHaveLength(300)
  await approve(request(page, 'permission'))
  await expectNoneWaiting(page)

  const record = records(page)
  await expect(record).toHaveCount(1)
  const full = `Approved: ${command} (W1 api-retry)`
  await expect(record).toHaveAttribute('title', full)
  const metrics = await record.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    height: el.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    ellipsis: getComputedStyle(el).textOverflow
  }))
  expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth)
  expect(metrics.ellipsis).toBe('ellipsis')
  // One line: no taller than a single line of text.
  expect(metrics.height).toBeLessThanOrEqual(metrics.lineHeight + 1)
})

test('8.9: after a failed "Bring them along" the record says it did not work, and a later "Set aside" adds a second record below it', async () => {
  const r = await setup('attention-record-timing', {
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty-clash' }
    ]
  })
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await sendToBrain(page, 'Start the web worker')
  await expectWaiting(page, 1, { timeout: 30_000 })

  await chooseForBranch(requests(page, 'branch'), 'Bring them along')
  const failed = 'Unsaved changes in web: Bring them along did not work (Arc)'
  await expect(records(page)).toHaveText(failed)
  await expect(records(page)).toHaveCount(1)
  await expect(records(page)).toHaveAttribute('data-record-failed', '')
  // The panel is back with the other three choices.
  await expectWaiting(page, 1)

  await chooseForBranch(requests(page, 'branch'), 'Set aside')
  await expectNoneWaiting(page)
  await expect(records(page)).toHaveCount(2)
  const lines = await entries(page)
  expect(lines.filter((e) => e.record).map((e) => e.text)).toEqual([
    failed,
    'Unsaved changes in web: Set aside (Arc)'
  ])
  await expect(records(page).first()).toHaveAttribute('data-record-failed', '')
  await expect(records(page).last()).not.toHaveAttribute('data-record-failed', '')
})

test('8.10: a message sent right after "Continue" appears below the record, and so does the brain\'s reply', async () => {
  const r = await setup('attention-record-timing', {
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty-no-dev' }
    ]
  })
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await sendToBrain(page, 'Start the web worker')
  await expectWaiting(page, 1, { timeout: 30_000 })

  await chooseForBranch(requests(page, 'branch'), 'Set aside')
  await sendToBrain(page, 'Say one more thing')
  await expect(page.getByText('One more thing from the brain.')).toBeVisible({ timeout: 30_000 })

  const all = await entries(page)
  const record = all.findIndex((e) => e.record)
  const mine = all.findIndex((e) => !e.record && e.text.includes('Say one more thing'))
  const reply = all.findIndex((e) => e.text.includes('One more thing from the brain.'))
  expect(record).toBeGreaterThanOrEqual(0)
  expect(record).toBeLessThan(mine)
  expect(record).toBeLessThan(reply)
})
