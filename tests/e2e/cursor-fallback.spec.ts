// @spec: 010-cursor-as-a-third-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { closeSettings, openSettings, providerRow, setDefault } from './codex-rig'
import {
  cursorAgents,
  cursorCancels,
  cursorPrompts,
  cursorSessions,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 Slice 5: a Cursor that isn't signed in hands its work to Claude and says why (2.6), a Cursor plan refusal
 * fails the worker with a plain sentence instead of waiting (2.6), the user can step in on a Cursor worker and
 * hand it back (2.3), and a Cursor worker resumes its own session after Arc is reopened. The brain is the fake Claude
 * CLI and every Cursor worker is the fake Cursor in `acp` mode; no model call is made.
 */

/** Arc's model probe opens its Cursor session in `userData/cursor-probe`. */
const isProbe = (cwd: string | undefined): boolean => cwd?.endsWith('/cursor-probe') ?? false

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(options: { scenario?: string; cursorScenario?: string }): Promise<CursorRig> {
  const r = await launchCursorRig({ ...options, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

const cursorStatus = (page: Page) => providerRow(page, 'cursor').locator('[data-provider-status]')

/** The worker sessions Arc opened on the fake Cursor (not the model probe's). */
const workerSessions = (r: CursorRig) => cursorSessions(r).filter((s) => !isProbe(s.cwd))

test('2.6: Cursor signed out and Workers on Cursor, so the worker runs on Claude and says why', async () => {
  // The brain (cx-spawn) starts one worker with no provider, so the Workers setting decides; the Claude worker
  // script of the same folder commits a file and reports done.
  const r = await setup({ scenario: 'cx-spawn' })
  const { page } = r
  // The user picked Cursor while it was signed in, then it signed out.
  await setDefault(page, 'Default workers', 'Cursor')
  r.setCursor({ FAKE_CURSOR_AUTH: 'signed_out' })
  await openSettings(page)
  await providerRow(page, 'cursor').getByRole('button', { name: 'Check Cursor again' }).click()
  await expect(cursorStatus(page)).toHaveText('Cursor · not signed in')
  await closeSettings(page)

  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()

  // The session says Cursor work runs on Claude for now, and the note can be dismissed.
  const note = page.getByText("Cursor isn't signed in, so Cursor work runs on Claude for now.")
  await expect(note).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check Cursor again' })).toBeVisible()

  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  // The card shows Claude standing in for Cursor, with the reason; the event log has the full sentence.
  const card = workerCard(page, 'W1 · review')
  const model = card.locator('[data-worker-model]')
  await expect(model).toContainText('Claude (Cursor unavailable)')
  await expect(model).toContainText(
    "Cursor isn't signed in. Run agent login in Terminal to use Cursor."
  )
  await expect(
    eventLog(page).filter({
      hasText:
        "Cursor isn't signed in, so W1 runs on Claude. Run agent login in Terminal to use Cursor."
    })
  ).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 45_000 })
  // No Cursor agent was started for it.
  expect(workerSessions(r)).toEqual([])
  expect(cursorAgents(r)).toEqual([])

  await page.getByRole('button', { name: 'Dismiss the Cursor note' }).click()
  await expect(note).toHaveCount(0)
})

test('2.6: a Cursor worker whose model is not on the plan fails with the plan sentence and does not wait', async () => {
  const r = await setup({ cursorScenario: 'cf-limit' })
  const { page } = r
  await startSession(page, { request: 'Add a limit file', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · limited')
  await expect(card.locator('[data-worker-model]')).toContainText('Cursor')
  // The plan block ("Upgrade your plan to continue", end_turn) is a refusal of the model, not a usage limit:
  // the worker fails at once with a sentence that names the model, and nothing waits or retries.
  await expect(
    eventLog(page).filter({
      hasText:
        "W1 limited failed: Cursor refused Auto: it isn't on your Cursor plan. Choose another model."
    })
  ).toHaveCount(1, { timeout: 20_000 })
  await expect(card).toHaveAttribute('data-worker-card', 'failed')
  await expect(eventLog(page).filter({ hasText: 'usage limit' })).toHaveCount(0)
  await page.waitForTimeout(1000)
  expect(cursorPrompts(r).filter((p) => p.role === 'worker')).toHaveLength(1)
  // A real usage limit (a Cursor wait with the same message as the other providers) is covered by
  // tests/unit/sessions/rate-limit-gate.test.ts and tests/unit/sessions/cursor-workers.test.ts.
})

const W1 = 'W1 · api-retry'

test('2.3: step in on a working Cursor worker, ask it something, hand back, and it continues its task', async () => {
  const r = await setup({ cursorScenario: 'cf-step' })
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toContainText('Cursor')
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  const terminal = page.getByRole('log', { name: `${W1} output` })
  await expect(terminal.getByText('Working on the retry.')).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Step in', exact: true }).click()
  await expect(terminal.getByText('You stepped in')).toBeVisible()
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")
  // Stepping in cancels the running Cursor turn.
  await expect.poll(() => cursorCancels(r)).toBe(1)

  const input = page.getByLabel(`Message to ${W1}`)
  await input.fill('What have you changed so far?')
  await input.press('Enter')
  await expect(terminal.getByText('> What have you changed so far?')).toBeVisible()
  await expect(terminal.getByText('Earlier I added retry.txt with retries = 3.')).toBeVisible()
  // The question went verbatim into the same Cursor session, not a new one.
  const sessionId = workerSessions(r)[0]?.sessionId
  expect(sessionId).toBeDefined()
  const asked = cursorPrompts(r).filter((p) => p.text.includes('What have you changed so far?'))
  expect(asked).toHaveLength(1)
  expect(asked[0]!.sessionId).toBe(sessionId)
  expect(workerSessions(r)).toHaveLength(1)

  await page.getByRole('button', { name: 'Hand back', exact: true }).click()
  await expect(input).toHaveCount(0)
  await expect(eventLog(page).filter({ hasText: /You handed W1 api-retry back/ })).toHaveCount(1)
  // The worker continues its task after the hand-back and is merged.
  await expect(terminal.getByText('Back to my task and done.')).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  expect(workerSessions(r)).toHaveLength(1)
})

test('2.3: a Cursor worker is resumed through session/load after Arc is closed and reopened, and finishes', async () => {
  const r = await setup({ cursorScenario: 'cf-resume' })
  const { page } = r
  await startSession(page, { request: 'Keep one worker busy', mode: 'Autonomous' })
  await expect(page.getByText('The Cursor worker is running.')).toBeVisible()
  const card = workerCard(page, 'W1 · keeper')
  await expect(card.locator('[data-worker-model]')).toContainText('Cursor')
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  await expect(
    page.getByRole('log', { name: 'W1 · keeper output' }).getByText('Working on the keeper.')
  ).toBeVisible({ timeout: 20_000 })
  const first = workerSessions(r).filter((s) => s.method === 'session/new')
  expect(first).toHaveLength(1)
  const sessionId = first[0]!.sessionId
  expect(sessionId).toBeDefined()

  await r.relaunch()
  const reopened = r.page
  await reopened
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await reopened.locator('[data-session-row]').first().click()
  const again = workerCard(reopened, 'W1 · keeper')
  await expect(again).toHaveAttribute('data-worker-card', 'stopped')

  await reopened
    .locator('[data-continue-prompt="open"]')
    .getByRole('button', { name: 'Continue' })
    .click()

  // Arc loads the earlier Cursor session instead of starting a new one, and the resumed script runs.
  await expect
    .poll(() =>
      workerSessions(r)
        .filter((s) => s.method === 'session/load')
        .map((s) => s.sessionId)
    )
    .toEqual([sessionId])
  expect(workerSessions(r).filter((s) => s.method === 'session/new')).toHaveLength(1)
  await expect
    .poll(() => cursorAgents(r).filter((a) => a.resumed))
    .toEqual([
      expect.objectContaining({
        role: 'worker',
        slug: 'keeper',
        resumed: true,
        script: expect.stringMatching(/cf-resume\/worker-resumed\.jsonl$/)
      })
    ])
  await again.getByRole('button').first().click()
  await expect(
    reopened
      .getByRole('log', { name: 'W1 · keeper output' })
      .getByText('Finished after the restart.')
  ).toBeVisible({ timeout: 30_000 })
  await expect(again).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})
