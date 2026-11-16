// @spec: 007-codex-as-a-second-provider
// @regression
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchCodexRig, readCodexLog, setDefault } from './codex-rig'
import {
  answerQuestion,
  approve,
  deny,
  expectNoneWaiting,
  expectWaiting,
  pendingAction,
  permissionAction,
  request
} from './attention-rig'
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
  await expectWaiting(page, 1)
  const panel = request(page, 'permission')
  await expect(permissionAction(panel)).toHaveText('git push origin arc/fix-order-sync')
  await expect(panel.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  // Waiting: the push has not run.
  await page.waitForTimeout(1000)
  expect(shellRuns(r)).toEqual([])

  await approve(panel)
  await expectNoneWaiting(page)
  await expect.poll(() => shellRuns(r).length).toBe(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: a Codex worker asks a question the brain cannot answer; it reaches Needs attention and the worker continues after the answer', async () => {
  const r = await setup('cx-ask', 'cx-ask')
  const { page } = r
  await startSession(page, { request: 'How many retries?', mode: 'Autonomous' })

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')
  await expectWaiting(page, 1)
  const question = request(page, 'question')
  await expect(question.getByText('How many retries should the client make?')).toBeVisible()
  await answerQuestion(question, 'Five attempts')

  await expectNoneWaiting(page)
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

// ---- Spec 015 slice 5: Skip all approvals lifts the Codex sandbox ----------------------------------------------

const skipSwitch = (page: Page) => page.getByLabel('Skip all approvals', { exact: true })
const skipDialog = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const skipMarker = (page: Page) => page.locator('[data-skip-approvals-on]')

/** Header Approvals popover, the switch, the warning dialog's confirm. */
async function turnSkipOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approvals' }).click()
  await skipSwitch(page).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(skipMarker(page)).toBeVisible()
  // Confirming closes the Approvals menu too, so the warning never sits under it.
  await expect(page.getByRole('dialog', { name: 'Approvals', exact: true })).toHaveCount(0)
}

/** The marker's own "Turn off", which asks for no warning dialog. */
async function turnSkipOff(page: Page): Promise<void> {
  await skipMarker(page).click()
  await page
    .getByRole('dialog', { name: 'Turn Skip all approvals off?' })
    .getByRole('button', { name: 'Turn off' })
    .click()
  await expect(skipMarker(page)).toHaveCount(0)
}

interface TurnStart {
  text: string
  sandboxPolicy?: unknown
}

/** Every `turn/start` the fake Codex received, with the `sandboxPolicy` it carried (absent when none was sent). */
function turnStarts(r: CodexRig): TurnStart[] {
  return readCodexLog(r).flatMap((l) => {
    const recv = l['recv'] as
      | { method?: string; params?: { input?: { text?: string }[]; sandboxPolicy?: unknown } }
      | undefined
    if (recv?.method !== 'turn/start') return []
    const text = (recv.params?.input ?? []).map((i) => i.text ?? '').join('\n')
    return [
      {
        text,
        ...(recv.params?.sandboxPolicy !== undefined
          ? { sandboxPolicy: recv.params.sandboxPolicy }
          : {})
      }
    ]
  })
}

const turnFor = (r: CodexRig, text: string): TurnStart | undefined =>
  turnStarts(r).find((t) => t.text.includes(text))

/** The `thread/start` sandbox of each worker thread the fake Codex served. */
function workerSandboxes(r: CodexRig): unknown[] {
  return readCodexLog(r).flatMap((l) => {
    const t = l['thread'] as { method?: string; role?: string; sandbox?: unknown } | undefined
    return t?.method === 'thread/start' && t.role === 'worker' ? [t.sandbox] : []
  })
}

/** Lets the scripted worker's first turn end: writes the gate file it waits for in its working copy. */
async function releaseGate(r: CodexRig): Promise<void> {
  const cwd = (): string | undefined =>
    readCodexLog(r)
      .map((l) => l['thread'] as { role?: string; cwd?: string } | undefined)
      .find((t) => t?.role === 'worker')?.cwd
  await expect.poll(cwd).toBeTruthy()
  writeFileSync(join(cwd()!, 'gate1'), '')
}

async function startCodexSession(page: Page, skip: boolean): Promise<void> {
  if (!skip) {
    await startSession(page, { request: 'Run the Codex skip checks', mode: 'Autonomous' })
    return
  }
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Request').fill('Run the Codex skip checks')
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await dialog.getByLabel('Skip all approvals', { exact: true }).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Start' }).click()
}

test('015 2.5: skip turned on while a Codex worker runs lifts its sandbox from the next turn, covers extra permissions and still asks for a push', async () => {
  const r = await setup('cx-skip', 'cx-skip')
  const { page } = r
  await startCodexSession(page, false)
  const card = workerCard(page, 'W1 · skip')
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  // Turn one runs with the plain sandbox: no per-turn policy was sent.
  await expect.poll(() => turnStarts(r).length).toBe(1)
  expect(turnStarts(r)[0]?.sandboxPolicy).toBeUndefined()
  expect(workerSandboxes(r)).toEqual(['workspace-write'])

  await turnSkipOn(page)
  await releaseGate(r)

  // The nudge turn carries dangerFullAccess.
  await expect.poll(() => turnFor(r, 'You have not called report_done')).toBeDefined()
  expect(turnFor(r, 'You have not called report_done')?.sandboxPolicy).toEqual({
    type: 'dangerFullAccess'
  })

  // The extra-permissions request is approved with the event text and never docks.
  await expect(
    eventLog(page).filter({
      hasText:
        'Approved (skipping approvals): Extra access: Write the notes outside the working copy'
    })
  ).toHaveCount(1)
  await expect
    .poll(() =>
      readCodexLog(r).some((l) => {
        const recv = l['recv'] as { result?: { permissions?: unknown; scope?: string } } | undefined
        return (
          recv?.result?.scope === 'turn' &&
          JSON.stringify(recv.result.permissions) ===
            JSON.stringify({ fileSystem: { write: ['/Users/redgell/v9-outside'] } })
        )
      })
    )
    .toBe(true)

  // The push is still a request, and nothing ran until it is decided.
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/skip')
  expect(shellRuns(r).filter((s) => s.cmd.includes('pushed.txt'))).toEqual([])
  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)
})

test('015 2.5: a Codex worker started with skip on has a danger-full-access sandbox; turning skip off restores the workspace sandbox from the next turn', async () => {
  const r = await setup('cx-skip', 'cx-skip')
  const { page } = r
  await startCodexSession(page, true)
  await expect(skipMarker(page)).toBeVisible()
  const card = workerCard(page, 'W1 · skip')
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await expect.poll(() => workerSandboxes(r)).toEqual(['danger-full-access'])
  await expect.poll(() => turnStarts(r).length).toBe(1)

  await turnSkipOff(page)
  await releaseGate(r)

  await expect.poll(() => turnFor(r, 'You have not called report_done')).toBeDefined()
  const restored = turnFor(r, 'You have not called report_done')?.sandboxPolicy as
    { type?: string; writableRoots?: unknown } | undefined
  expect(restored).toMatchObject({
    type: 'workspaceWrite',
    networkAccess: false,
    excludeSlashTmp: true,
    excludeTmpdirEnvVar: true
  })
  expect(Array.isArray(restored?.writableRoots)).toBe(true)

  // With skip off the extra-permissions request asks again.
  await expectWaiting(page, 1)
  await expect(request(page, 'permission')).toBeVisible()
  await expect(
    eventLog(page).filter({ hasText: 'Approved (skipping approvals): Write the notes' })
  ).toHaveCount(0)
  await deny(request(page, 'permission'))
  await expectWaiting(page, 1)
  expect(await pendingAction(page)).toBe('git push origin arc/skip')
  await deny(request(page, 'permission'))
  await expectNoneWaiting(page)
})
