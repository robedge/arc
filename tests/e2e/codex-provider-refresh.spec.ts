// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  chooseFromMenu,
  closeSettings,
  codexThreads,
  codexTurns,
  launchCodexRig,
  openSettings,
  providerRow,
  setDefault
} from './codex-rig'
import type { CodexRig } from './codex-rig'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 007 section 2.8, new models and provider updates picked up without a restart. The fake Codex reads its answers
 * from a state file on every run, so a test can "install" a new model or a new version while Arc runs.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const OLD_MODEL = { model: 'fake-old', displayName: 'Fake Old', isDefault: true }
const NEW_MODEL = { model: 'fake-new', displayName: 'Fake New' }
const OLD = JSON.stringify([OLD_MODEL])
const BOTH = JSON.stringify([OLD_MODEL, NEW_MODEL])

async function checkAgain(page: Page): Promise<void> {
  await providerRow(page, 'codex').getByRole('button', { name: 'Check Codex again' }).click()
}

test('2.8: a model that was not there last time is in the Settings, header and plan card lists when Arc opens', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-plan',
    codexScenario: 'cx-spawn',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_MODELS: OLD }
  })
  rig = r
  const { page, repos } = r
  await openSettings(page)
  await expect(
    page.getByLabel('Default brain').locator('option', { hasText: 'Fake Old' })
  ).toHaveCount(1)
  await expect(
    page.getByLabel('Default brain').locator('option', { hasText: 'Fake New' })
  ).toHaveCount(0)
  await closeSettings(page)

  // The provider now offers another model; Arc is opened again.
  r.setCodex({ FAKE_CODEX_MODELS: BOTH })
  await r.relaunch()
  const again = r.page
  await openSettings(again)
  for (const picker of ['Default brain', 'Default workers']) {
    await expect(again.getByLabel(picker).locator('option', { hasText: 'Fake New' })).toHaveCount(1)
  }
  await closeSettings(again)

  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(again, { request: 'Add retry' })
  for (const menu of ['Brain model', 'Worker model']) {
    await again.getByRole('button', { name: menu }).click()
    await expect(
      again
        .getByRole('menu', { name: menu })
        .getByRole('menuitemradio', { name: 'Fake New', exact: true })
    ).toBeVisible()
    await again.keyboard.press('Escape')
  }
  const plan = again.locator('[data-plan-card="proposed"]')
  await expect(plan).toBeVisible()
  await plan.getByLabel('Provider for api-retry').selectOption('codex')
  await expect(
    plan.getByLabel('Model for api-retry').locator('option', { hasText: 'Fake New' })
  ).toHaveCount(1)
})

test('2.8: a model that appears mid-session can be picked in the header and the next reply comes from it, with the conversation kept', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-newmodel',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_MODELS: OLD }
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Patch hello please', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await page.getByRole('button', { name: 'Brain model' }).click()
  await expect(
    page.getByRole('menu', { name: 'Brain model' }).getByRole('menuitemradio', { name: 'Fake New' })
  ).toHaveCount(0)
  await page.keyboard.press('Escape')

  // The new model arrives; the user checks again.
  r.setCodex({ FAKE_CODEX_MODELS: BOTH })
  await openSettings(page)
  await checkAgain(page)
  await expect(
    page.getByLabel('Default brain').locator('option', { hasText: 'Fake New' })
  ).toHaveCount(1)
  await closeSettings(page)

  await chooseFromMenu(page, 'Brain model', 'Fake New')
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(
    /Brain · Codex Fake New/i
  )
  await page.getByPlaceholder('Message the brain').fill('And now a question for the new model')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect(page.getByText('Hello from the new model.')).toBeVisible()

  const turn = codexTurns(r).at(-1)!
  expect(turn.model).toBe('fake-new')
  // The conversation is kept: the earlier request travels with the first Codex turn.
  expect(turn.text).toContain('Patch hello please')
  expect(turn.text).toContain('And now a question for the new model')
})

test('2.8: after the update is run in Terminal, Check again shows the new version; the brain and the next worker use it and the running worker is left alone', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-update',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_VERSION: '0.162.1' },
    latest: { codex: '0.170.0' }
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Fake Deep')
  await startSession(page, { request: 'Keep two workers busy', mode: 'Autonomous' })
  const first = workerCard(page, 'W1 · first')
  await expect(first).toHaveAttribute('data-worker-card', 'working')
  expect(codexThreads(r).map((t) => [t.role, t.version])).toEqual([
    ['brain', '0.162.1'],
    ['worker', '0.162.1']
  ])

  // The user runs `codex update` in Terminal and comes back to Arc.
  r.setCodex({ FAKE_CODEX_VERSION: '0.170.0' })
  await openSettings(page)
  await expect(providerRow(page, 'codex').locator('[data-provider-update]')).toBeVisible()
  await checkAgain(page)
  await expect(providerRow(page, 'codex').locator('[data-provider-version]')).toHaveText('0.170.0')
  await expect(providerRow(page, 'codex').locator('[data-provider-update]')).toHaveCount(0)
  await closeSettings(page)

  // The brain's next reply runs on the new version with the same thread, and starts a worker that does too.
  await page.getByPlaceholder('Message the brain').fill('Start the second worker')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect(page.getByText('The second worker is running.')).toBeVisible()
  const second = workerCard(page, 'W2 · second')
  await expect(second).toHaveAttribute('data-worker-card', 'working')
  const threads = codexThreads(r)
  expect(threads.map((t) => [t.role, t.method, t.version])).toEqual([
    ['brain', 'thread/start', '0.162.1'],
    ['worker', 'thread/start', '0.162.1'],
    ['brain', 'thread/resume', '0.170.0'],
    ['worker', 'thread/start', '0.170.0']
  ])
  // The first worker keeps running on what it started with: no second thread was made for it.
  await expect(first).toHaveAttribute('data-worker-card', 'working')
  expect(threads.filter((t) => t.slug === 'first')).toHaveLength(1)
})

async function launchWithRunningWorker(): Promise<CodexRig> {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-update',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_VERSION: '0.162.1' }
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await setDefault(r.page, 'Default brain', 'Fake Deep')
  await startSession(r.page, { request: 'Keep two workers busy', mode: 'Autonomous' })
  await expect(workerCard(r.page, 'W1 · first')).toHaveAttribute('data-worker-card', 'working')
  return r
}

/** The installed Codex is now older than Arc supports while an agent runs on it: no live switch is possible. */
async function breakTheUpdate(r: CodexRig): Promise<void> {
  r.setCodex({ FAKE_CODEX_VERSION: '0.1.0' })
  await openSettings(r.page)
  await checkAgain(r.page)
  await closeSettings(r.page)
}

const restartPrompt = (page: Page) =>
  page.getByRole('dialog', { name: 'Restart Arc to finish updating Codex' })

test('2.8: when Arc cannot move to the updated tool it asks for a restart; Later keeps working', async () => {
  const r = await launchWithRunningWorker()
  await breakTheUpdate(r)
  const prompt = restartPrompt(r.page)
  await expect(prompt).toBeVisible()
  await expect(prompt.getByRole('button', { name: 'Restart now' })).toBeVisible()
  await prompt.getByRole('button', { name: 'Later' }).click()
  await expect(prompt).toHaveCount(0)
  await expect(workerCard(r.page, 'W1 · first')).toHaveAttribute('data-worker-card', 'working')
})

test('2.8: Restart now reopens Arc and the open session continues where it left off', async () => {
  const r = await launchWithRunningWorker()
  // Restart now would relaunch the real app; the test stands in for the relaunch and records the call.
  const relaunched = join(r.home, 'relaunch-requested')
  await r.app.evaluate(({ app }, file) => {
    const fs = process.getBuiltinModule('node:fs')
    app.relaunch = () => {
      fs.writeFileSync(file, '1')
    }
  }, relaunched)
  await breakTheUpdate(r)
  await restartPrompt(r.page).getByRole('button', { name: 'Restart now' }).click()
  await expect.poll(() => existsSync(relaunched), { timeout: 15_000 }).toBe(true)

  // Arc comes back, now on the updated Codex, and the session is where it was left.
  r.setCodex({ FAKE_CODEX_VERSION: '0.170.0' })
  await r.relaunch()
  const again = r.page
  await again
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await again.locator('[data-session-row]').first().click()
  await expect(again.locator('[data-message-role="user"]').first()).toHaveText(
    'Keep two workers busy'
  )
  await expect(workerCard(again, 'W1 · first')).toHaveAttribute('data-worker-card', 'stopped')
  await expect(eventLog(again).filter({ hasText: 'started W1 first' })).toHaveCount(1)
  await again.getByRole('tablist', { name: 'Conversation' }).getByRole('tab').first().click()
  await again.getByPlaceholder('Message the brain').fill('Start the second worker')
  await again.getByPlaceholder('Message the brain').press('Enter')
  await expect(again.getByText('The second worker is running.')).toBeVisible()
})

test('2.8: coming back to Arc a while after the update was run in Terminal shows the new version, without Check again', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_VERSION: '0.162.1' },
    latest: { codex: '0.170.0' }
  })
  rig = r
  const { page } = r
  await openSettings(page)
  const codex = providerRow(page, 'codex')
  await expect(codex.locator('[data-provider-update]')).toContainText('0.162.1 → 0.170.0')

  r.setCodex({ FAKE_CODEX_VERSION: '0.170.0' })
  // Eleven minutes pass, then the window gets the focus again (Arc checks again after ten).
  await r.app.evaluate(({ BrowserWindow }) => {
    const real = Date.now.bind(Date)
    Date.now = () => real() + 11 * 60 * 1000
    BrowserWindow.getAllWindows()[0]?.emit('focus')
  })
  await expect(codex.locator('[data-provider-version]')).toHaveText('0.170.0')
  await expect(codex.locator('[data-provider-update]')).toHaveCount(0)
})
