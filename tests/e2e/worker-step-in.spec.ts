// @spec: 006-stepping-in-on-a-worker
// @regression
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  eventLog,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Acceptance flows for spec 006, driven through the built app with the fake CLI (no model call).
 *
 * Two criteria are about what a model does with the user's words: "refers to its earlier work" (2.2) and "later
 * work uses 5 retries" (2.4). The fake CLI cannot reason, so those two assert the mechanism that makes them true:
 * the user's text reaches the SAME conversation (the same process while it lives, `--resume` of the same session
 * id after a restart) verbatim, and the hand-back turn that follows it reaches that conversation too.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const W1 = 'W1 · api-retry'
/** The event log names a worker without the middle dot (`workerLabel`), unlike the card and tab titles. */
const W1_LOG = 'W1 api-retry'
const badge = (page: Page) => page.getByRole('button', { name: /Needs attention, \d+ waiting/ })
const tabs = (page: Page) => page.getByRole('tablist', { name: 'Conversation' })
const terminal = (page: Page) => page.getByRole('log', { name: `${W1} output` })
const input = (page: Page) => page.getByLabel(`Message to ${W1}`)
const stepInButton = (page: Page) => page.getByRole('button', { name: 'Step in', exact: true })
const handBackButton = (page: Page) => page.getByRole('button', { name: 'Hand back', exact: true })

async function setup(scenario: string, repos: string[] = ['api']): Promise<Rig> {
  const r = await launchRig({ scenario, repos: repos.map((name) => ({ name })) })
  rig = r
  await createGroupWithProjects(
    r,
    'Storefront',
    repos.map((name) => r.repos[name]!)
  )
  return r
}

/** The header row (status, control chip, buttons) must stay inside its panel, even with a long status label. */
async function expectHeaderFits(page: Page): Promise<void> {
  const panel = await page.locator('[data-terminal-tab]').boundingBox()
  const details = await page
    .locator('[data-terminal-header]')
    .getByRole('button', { name: 'Details', exact: true })
    .boundingBox()
  expect(panel).not.toBeNull()
  expect(details).not.toBeNull()
  expect(details!.x + details!.width).toBeLessThanOrEqual(panel!.x + panel!.width)
}

async function openTab(page: Page, title: string): Promise<void> {
  await workerCard(page, title).getByRole('button').first().click()
  await expect(tabs(page).getByRole('tab', { name: title })).toHaveAttribute(
    'aria-selected',
    'true'
  )
}

/** Every stdin record of the fake CLI processes, as text. */
function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

function interrupts(r: Rig): number {
  return readFakeLog(r).filter((l) => {
    const s = l['stdin'] as { type?: string; request?: { subtype?: string } } | undefined
    return s?.type === 'control_request' && s.request?.subtype === 'interrupt'
  }).length
}

/** The output of the first fake-CLI shell step whose command contains `needle`. */
function shellOut(r: Rig, needle: string): string | undefined {
  for (const l of readFakeLog(r)) {
    const sh = l['shell'] as { cmd?: string; out?: string } | undefined
    if (sh?.cmd?.includes(needle)) return sh.out ?? ''
  }
  return undefined
}

function mcpResult(r: Rig, tool: string): { isError: boolean; text: string } | undefined {
  const rec = readFakeLog(r).find((l) => {
    const m = l['mcpResult'] as { tool?: string } | undefined
    return m?.tool === tool
  })
  return rec ? (rec['mcpResult'] as { isError: boolean; text: string }) : undefined
}

function workerLaunches(r: Rig): string[][] {
  return readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is string[] => Array.isArray(a) && a.some((x) => String(x).includes('arc-role:worker'))
    )
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

test('2.1 + 2.2 + 2.4: step in, ask, slash command, hand back, and the worker finishes', async () => {
  const r = await setup('step-in')
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  // The worker has made an edit in its working copy before the user steps in.
  await expect.poll(() => shellOut(r, 'retry.txt')).not.toBe(undefined)
  const worktree = shellOut(r, 'retry.txt')!.split('\n')[0]!.trim()
  expect(worktree).not.toBe('')

  await openTab(page, W1)
  // Not controlled yet: Step in is offered, there is no input line and no Hand back.
  await expect(stepInButton(page)).toBeVisible()
  await expect(input(page)).toHaveCount(0)
  await expect(handBackButton(page)).toHaveCount(0)
  const launchesBefore = workerLaunches(r).length

  await stepInButton(page).click()

  // 2.1: the interrupt is sent, the tab says so, offers a prompt, and the card shows who is in control.
  await expect(terminal(page).getByText('You stepped in')).toBeVisible()
  await expect(input(page)).toBeVisible()
  await expect(input(page)).toBeFocused()
  await expect(handBackButton(page)).toBeVisible()
  await expect(stepInButton(page)).toHaveCount(0)
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")
  await expect(card.locator('[data-worker-control]')).toHaveAttribute(
    'data-worker-control',
    'active'
  )
  expect(interrupts(r)).toBe(1)
  await expect(eventLog(page).filter({ hasText: `You stepped in on ${W1_LOG}` })).toHaveCount(1)
  // The edit made before the step-in is still in the working copy.
  expect(readFileSync(`${worktree}/retry.txt`, 'utf8')).toBe('retries = 3\n')
  // The interrupted turn is not judged: no "report_done" nudge reaches the worker.
  await page.waitForTimeout(1500)
  expect(stdinTexts(r).filter((t) => t.includes('You have not called report_done'))).toEqual([])

  // 2.2: a typed line is echoed, reaches the worker verbatim, and its answer appears in the tab.
  await input(page).fill('What have you changed so far?')
  await input(page).press('Enter')
  await expect(terminal(page).getByText('> What have you changed so far?')).toBeVisible()
  await expect(
    terminal(page).getByText('Earlier I added retry.txt with retries = 3.')
  ).toBeVisible()
  expect(stdinTexts(r).filter((t) => t.includes('What have you changed so far?'))).toHaveLength(1)
  // Mechanism for "refers to its earlier work": the line went into the same live conversation, not a new one.
  expect(workerLaunches(r)).toHaveLength(launchesBefore)

  // A slash command reaches the worker verbatim.
  await input(page).fill('/awos:spec x')
  await input(page).press('Enter')
  await expect(terminal(page).getByText('Got the spec command.')).toBeVisible()
  expect(stdinTexts(r).some((t) => t.includes('"text":"/awos:spec x"'))).toBe(true)

  // 2.4: "use 5 retries" is typed while in control and the worker edits again.
  await input(page).fill('use 5 retries, not 3')
  await input(page).press('Enter')
  await expect(terminal(page).getByText('Switched to 5 retries.')).toBeVisible()
  await expect
    .poll(() => stdinTexts(r).filter((t) => t.includes('use 5 retries, not 3')).length)
    .toBe(1)
  expect(readFileSync(`${worktree}/retry-config.txt`, 'utf8')).toBe('retries = 5\n')

  await handBackButton(page).click()

  // The tab is watch-only again, the card shows the worker working, and the event log says so.
  await expect(input(page)).toHaveCount(0)
  await expect(stepInButton(page)).toBeVisible()
  await expect(card.locator('[data-worker-control]')).toHaveCount(0)
  await expect(card.locator('[data-worker-status]')).not.toHaveText(/in control/i)
  await expect(eventLog(page).filter({ hasText: `You handed ${W1_LOG} back` })).toHaveCount(1)
  await expect(terminal(page).getByText('You handed back')).toBeVisible()

  // The worker continues: the hand-back turn comes after the user's text in the same conversation, the brain is
  // told what changed, and the worker finishes and is merged.
  await expect
    .poll(() => stdinTexts(r).some((t) => t.includes('handed control back to you')))
    .toBe(true)
  const texts = stdinTexts(r)
  const said = texts.findIndex((t) => t.includes('use 5 retries, not 3'))
  const back = texts.findIndex((t) => t.includes('handed control back to you'))
  expect(said).toBeGreaterThan(-1)
  expect(back).toBeGreaterThan(said)
  expect(workerLaunches(r)).toHaveLength(launchesBefore)
  expect(
    texts.some(
      (t) =>
        t.includes('handed') && t.includes('retry-config.txt') && t.includes('use 5 retries, not 3')
    )
  ).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  expect(stdinTexts(r).filter((t) => t.includes('You have not called report_done'))).toEqual([])

  // 2.1: a finished worker offers no Step in.
  await expect(stepInButton(page)).toHaveCount(0)
  await expect(handBackButton(page)).toHaveCount(0)
})

test('2.1: a worker waiting on a question moves it from Needs attention into its terminal', async () => {
  const r = await setup('attention-escalate')
  const { page } = r
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')
  await expect(badge(page)).toHaveCount(1)

  // A card in an attention state opens the dialog, so the way in is the worker's details.
  await page.getByRole('button', { name: `Details for ${W1}` }).click()
  await page
    .getByRole('dialog', { name: W1 })
    .getByRole('button', { name: 'Step in', exact: true })
    .click()
  await expect(tabs(page).getByRole('tab', { name: W1 })).toHaveAttribute('aria-selected', 'true')

  // The question leaves Needs attention and is pinned above the input in the terminal.
  await expect(badge(page)).toHaveCount(0)
  const pinned = page.getByRole('group', { name: 'Needs your answer' })
  await expect(pinned.getByText('How many retries should the client make?')).toBeVisible()
  await expectHeaderFits(page)
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")

  await pinned.getByLabel('Your answer').fill('Five attempts')
  await pinned.getByRole('button', { name: 'Send' }).click()
  await expect(pinned).toHaveCount(0)
  // The answer given in the terminal is the tool result the worker gets.
  await expect.poll(() => mcpResult(r, 'ask_brain')?.text ?? '').toContain('Five attempts')
  await expect(badge(page)).toHaveCount(0)
})

test('2.2: a push asks in the terminal, not in Needs attention, and runs only after Approve; Escape stops a reply', async () => {
  const r = await setup('step-in-push')
  const { page } = r
  await startSession(page, { request: 'Add retry then push', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await openTab(page, W1)
  await stepInButton(page).click()
  await expect(input(page)).toBeVisible()

  await input(page).fill('Please push the branch')
  await input(page).press('Enter')

  const pinned = page.getByRole('group', { name: 'Needs your answer' })
  await expect(pinned.locator('[data-action]')).toHaveText('git push origin arc/push-change')
  await expect(pinned.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(pinned.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  await expectHeaderFits(page)
  await expect(pinned.getByRole('button', { name: /Always allow/ })).toHaveCount(0)
  // Nothing in Needs attention, the brain was never asked, and the push has not run.
  await expect(badge(page)).toHaveCount(0)
  await page.waitForTimeout(1000)
  expect(readFakeLog(r).filter((l) => 'permission' in l)).toEqual([])
  await expect(terminal(page).getByText('(fake) ran: git push')).toHaveCount(0)
  expect(stdinTexts(r).filter((t) => t.includes('(request '))).toEqual([])

  await pinned.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(() =>
      readFakeLog(r)
        .filter((l) => 'permission' in l)
        .map((l) => (l['permission'] as { behavior: string }).behavior)
    )
    .toEqual(['allow'])
  await expect(
    terminal(page).getByText('Pushed. Writing a long summary of everything.')
  ).toBeVisible()

  // The worker is replying: Escape interrupts, "Interrupted" shows, and the prompt is still there.
  const before = interrupts(r)
  await input(page).press('Escape')
  await expect.poll(() => interrupts(r)).toBe(before + 1)
  await expect(terminal(page).getByText('Interrupted')).toBeVisible()
  await expect(input(page)).toBeEnabled()
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")
})

test('2.3: the brain waits while the user is in control; another worker merges as usual; hand-back delivers the held message', async () => {
  const r = await setup('step-in-brain', ['api', 'web'])
  const { page } = r
  await startSession(page, { request: 'Two jobs', mode: 'Autonomous' })

  const w1 = workerCard(page, W1)
  const w2 = workerCard(page, 'W2 · web-quick')
  await expect(w1).toHaveAttribute('data-worker-card', 'working')
  await expect(w2).toHaveAttribute('data-worker-card', 'working')

  await openTab(page, W1)
  await stepInButton(page).click()
  await expect(input(page)).toBeVisible()

  // The brain's message to W1 is held, and its merge of W1 is refused with the reason.
  await expect.poll(() => mcpResult(r, 'message_worker')?.text ?? '').toContain('queued')
  await expect.poll(() => mcpResult(r, 'merge_worker')?.text ?? '').toContain('worker_user_control')
  expect(mcpResult(r, 'merge_worker')?.isError).toBe(true)
  // Nothing from the brain appears in the user's terminal or reaches W1.
  await expect(terminal(page).getByText('Remember to add a changelog line')).toHaveCount(0)
  expect(stdinTexts(r).filter((t) => t.includes('Remember to add a changelog line'))).toEqual([])

  // Another worker finishes and is merged as usual while W1 is controlled.
  await expect(w2).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  await expect(w1.locator('[data-worker-status]')).toHaveText("You're in control")

  await input(page).fill('use 5 retries')
  await input(page).press('Enter')
  await expect(terminal(page).getByText('Switched to 5 retries.')).toBeVisible()

  await handBackButton(page).click()

  // After hand-back the worker gets the hand-back text, then the held brain message, in that order.
  await expect
    .poll(() => stdinTexts(r).some((t) => t.includes('Remember to add a changelog line')))
    .toBe(true)
  const texts = stdinTexts(r)
  // The held message rides in the hand-back turn itself, after the hand-back text.
  const turn = texts.find((t) => t.includes('Remember to add a changelog line'))!
  expect(turn.indexOf('handed control back to you')).toBeGreaterThan(-1)
  expect(turn.indexOf('Remember to add a changelog line')).toBeGreaterThan(
    turn.indexOf('handed control back to you')
  )
  // The brain was told what changed.
  expect(
    texts.some(
      (t) =>
        t.includes('The user handed') && t.includes('retry-config.txt') && t.includes('1 message')
    )
  ).toBe(true)
  await expect(w1).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.5: closing a controlled tab asks; Keep it paused keeps control; quitting leaves it paused with Hand back offered', async () => {
  const r = await setup('step-in')
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await openTab(page, W1)
  await stepInButton(page).click()
  await expect(input(page)).toBeVisible()

  // The close dialog offers three outcomes; Cancel leaves the tab open.
  await page.getByRole('button', { name: `Close ${W1}` }).click()
  const dialog = page.getByRole('dialog', { name: `Hand ${W1} back to the brain?` })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button')).toHaveText(['Cancel', 'Keep it paused', 'Hand back'])
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(tabs(page).getByRole('tab', { name: W1 })).toBeVisible()

  // Keep it paused closes the tab; the card still shows control.
  await page.getByRole('button', { name: `Close ${W1}` }).click()
  await dialog.getByRole('button', { name: 'Keep it paused' }).click()
  await expect(tabs(page).getByRole('tab')).toHaveText(['Brain'])
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")
  expect(interrupts(r)).toBe(1)
  const original = workerLaunches(r)
  expect(original).toHaveLength(1)
  expect(original[0]).not.toContain('--resume')

  // Quit while in control and reopen the session.
  await r.relaunch({ scenario: 'step-in-after' })
  const page2 = r.page
  await page2
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page2.locator('[data-session-row]').first().click()
  const card2 = workerCard(page2, W1)
  await expect(card2.locator('[data-worker-status]')).toHaveText("You're in control (paused)")
  await expect(card2).not.toHaveAttribute('data-worker-card', 'stopped')
  await expect(eventLog(page2).filter({ hasText: 'stopped when Arc quit' })).toHaveCount(0)

  // Its tab lets the user carry on or hand it back.
  await openTab(page2, W1)
  await expect(handBackButton(page2)).toBeVisible()
  await expect(input(page2)).toBeVisible()

  // Carrying on resumes the same conversation (a `--resume <session id>` launch) with the typed line.
  await input(page2).fill('Carry on from where you were')
  await input(page2).press('Enter')
  await expect.poll(() => workerLaunches(r).filter((argv) => flag(argv, '--resume')).length).toBe(1)
  await expect
    .poll(() => stdinTexts(r).filter((t) => t.includes('Carry on from where you were')).length)
    .toBe(1)
})

/** Nothing may scroll sideways: not the page, and not any ancestor of the terminal's scroll box. */
async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    const root = document.documentElement
    if (root.scrollWidth > window.innerWidth) {
      out.push(`html scrollWidth ${root.scrollWidth} > innerWidth ${window.innerWidth}`)
    }
    for (const el of [document.body, ...document.querySelectorAll('[data-terminal-log]')]) {
      let node: HTMLElement | null = el as HTMLElement
      while (node) {
        const name = `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}`
        if (node.scrollLeft > 0) out.push(`${name} scrollLeft ${node.scrollLeft}`)
        if (node.scrollWidth > node.clientWidth + 1) {
          out.push(`${name} scrollWidth ${node.scrollWidth} > clientWidth ${node.clientWidth}`)
        }
        node = node.parentElement
      }
    }
    return out
  })
}

test('2.1: long worker output wraps inside the terminal and never scrolls the page sideways', async () => {
  const r = await setup('step-in-long')
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(workerCard(page, W1)).toHaveAttribute('data-worker-card', 'working')
  await openTab(page, W1)
  await expect(terminal(page).getByText('file.ts', { exact: false }).first()).toBeVisible()
  await stepInButton(page).click()
  await expect(input(page)).toBeVisible()
  await page.waitForTimeout(600)

  expect(await horizontalOverflow(page)).toEqual([])
  // The sidebar is fully on screen.
  const nav = await page.getByRole('navigation', { name: 'Groups' }).boundingBox()
  expect(nav!.x).toBeGreaterThanOrEqual(0)
  // The long path is soft-wrapped into several rows, none wider than the terminal.
  const log = await terminal(page).boundingBox()
  const rows = await terminal(page)
    .locator('[data-terminal-line]')
    .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().right))
  expect(Math.max(...rows)).toBeLessThanOrEqual(log!.x + log!.width + 1)
  await expect(terminal(page).locator('[data-terminal-wrapped]').first()).toBeAttached()
  await page.screenshot({ path: 'docs/screenshots/006-stepping-in-on-a-worker-long-lines.png' })
})
