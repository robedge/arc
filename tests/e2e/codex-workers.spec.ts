// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { NEEDS_ATTENTION, launchCodexRig, readCodexLog, setDefault } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 007 section 2.4: Codex workers work like Claude workers. The brain is the fake Claude CLI (or the fake
 * Codex, for the resume test) and every worker is the fake Codex app-server; no model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const W1 = 'W1 · api-retry'
const badge = (page: Page) => page.getByRole('button', { name: NEEDS_ATTENTION })
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

async function setup(scenario: string, codexScenario: string): Promise<CodexRig> {
  const r = await launchCodexRig({ scenario, codexScenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

/** The commands the fake Codex really ran (its `shell` steps), as { cmd, code }. */
function shellRuns(r: CodexRig): { cmd: string }[] {
  return readCodexLog(r).flatMap((l) => {
    const sh = l['shell'] as { cmd?: string } | undefined
    return sh?.cmd === undefined ? [] : [{ cmd: sh.cmd }]
  })
}

test('2.4: a Codex worker asks to push; Needs attention shows the exact command and nothing runs until Approve', async () => {
  const r = await setup('cx-push', 'cx-push')
  const { page } = r
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText('git push origin arc/fix-order-sync')
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  // Waiting: the push has not run.
  await page.waitForTimeout(1000)
  expect(shellRuns(r)).toEqual([])

  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(badge(page)).toHaveCount(0)
  await expect.poll(() => shellRuns(r).length).toBe(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: a Codex worker asks a question the brain cannot answer; it reaches Needs attention and the worker continues after the answer', async () => {
  const r = await setup('cx-ask', 'cx-ask')
  const { page } = r
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.getByText('How many retries should the client make?')).toBeVisible()
  await dialog.getByLabel('Your answer').fill('Five attempts')
  await dialog.getByRole('button', { name: 'Send' }).click()

  await expect(badge(page)).toHaveCount(0)
  // The answer is the tool result the Codex worker gets, and it carries on.
  await expect
    .poll(() =>
      readCodexLog(r).some((l) => {
        const m = l['mcpResult'] as { tool?: string; text?: string } | undefined
        return m?.tool === 'ask_brain' && (m.text ?? '').includes('Five attempts')
      })
    )
    .toBe(true)
  await expect(page.locator('[data-worker-card]').first()).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    { timeout: 30_000 }
  )
})

test('2.4: step in on a working Codex worker, ask it something, hand back, and it continues its task', async () => {
  const r = await setup('cx-step', 'cx-step')
  const { page } = r
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  const terminal = page.getByRole('log', { name: `${W1} output` })
  await page.getByRole('button', { name: 'Step in', exact: true }).click()
  await expect(terminal.getByText('You stepped in')).toBeVisible()
  await expect(card.locator('[data-worker-status]')).toHaveText("You're in control")

  const input = page.getByLabel(`Message to ${W1}`)
  await input.fill('What have you changed so far?')
  await input.press('Enter')
  await expect(terminal.getByText('> What have you changed so far?')).toBeVisible()
  await expect(terminal.getByText('Earlier I added retry.txt with retries = 3.')).toBeVisible()

  await page.getByRole('button', { name: 'Hand back', exact: true }).click()
  await expect(input).toHaveCount(0)
  await expect(eventLog(page).filter({ hasText: /You handed W1 api-retry back/ })).toHaveCount(1)
  // The worker continues its task after the hand-back and is merged.
  await expect(terminal.getByText('Back to my task and done.')).toBeVisible({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
})

test('2.4: a Codex brain and a Codex worker are still there after Arc is closed and reopened, and the conversation continues', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-resume',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Fake Deep')
  await startSession(page, { request: 'Keep one worker busy', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(
    /Brain · Codex Fake Deep/i
  )
  await expect(page.locator('[data-brain-model]')).toHaveText('Codex · fake-deep')
  await expect(page.getByText('The Codex worker is running.')).toBeVisible()
  const card = workerCard(page, 'W1 · keeper')
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  await expect(
    page.getByRole('log', { name: 'W1 · keeper output' }).getByText('Working on the keeper.')
  ).toBeVisible()

  await r.relaunch()
  const reopened = r.page
  await reopened
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await reopened.locator('[data-session-row]').first().click()
  // The brain's conversation and the worker's history are there.
  await expect(reopened.locator('[data-message-role="user"]').first()).toHaveText(
    'Keep one worker busy'
  )
  await expect(reopened.getByText('The Codex worker is running.')).toBeVisible()
  const again = workerCard(reopened, 'W1 · keeper')
  await expect(again).toHaveAttribute('data-worker-card', 'stopped')
  await again.getByRole('button').first().click()
  await expect(
    reopened.getByRole('log', { name: 'W1 · keeper output' }).getByText('Working on the keeper.')
  ).toBeVisible()

  // The user can continue: the brain answers from its resumed Codex thread, and the worker can be continued.
  await reopened.getByRole('tablist', { name: 'Conversation' }).getByRole('tab').first().click()
  await reopened.getByPlaceholder('Message the brain').fill('What were we doing?')
  await reopened.getByPlaceholder('Message the brain').press('Enter')
  await expect(reopened.getByText('I remember the earlier conversation.')).toBeVisible()
  const resumes = readCodexLog(r).filter(
    (l) => (l['recv'] as { method?: string } | undefined)?.method === 'thread/resume'
  )
  expect(resumes.length).toBeGreaterThanOrEqual(1)
  await reopened
    .locator('[data-continue-prompt="open"]')
    .getByRole('button', { name: 'Continue' })
    .click()
  await expect(again).toHaveAttribute('data-worker-card', 'working')
})
