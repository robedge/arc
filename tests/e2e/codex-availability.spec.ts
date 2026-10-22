// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  closeSettings,
  launchCodexRig,
  openSettings,
  providerRow,
  readCodexLog,
  setDefault
} from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 007 section 2.7: when Codex is not installed or not signed in, work continues on Claude and the user is told
 * why. Signing out is simulated by changing what the fake Codex says between two checks. No model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const status = (page: Page) => providerRow(page, 'codex').locator('[data-provider-status]')

async function checkCodexAgain(page: Page, expected: string): Promise<void> {
  await providerRow(page, 'codex').getByRole('button', { name: 'Check Codex again' }).click()
  await expect(status(page)).toHaveText(expected)
}

async function setup(options: { installed?: boolean; codex?: Record<string, string> } = {}) {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-spawn',
    repos: [{ name: 'api' }],
    codexInstalled: options.installed ?? true,
    codex: options.codex ?? {}
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

test('2.7: Codex signed out and Workers on Codex, so the worker runs on Claude and says why', async () => {
  const r = await setup()
  const { page } = r
  // The user picked Codex while it worked, then it signed out.
  await setDefault(page, 'Default workers', 'Codex')
  r.setCodex({ FAKE_CODEX_AUTH: 'signed_out' })
  await openSettings(page)
  await checkCodexAgain(page, 'Codex · not signed in')
  await closeSettings(page)

  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toContainText('Claude (Codex unavailable)')
  await expect(
    eventLog(page).filter({
      hasText:
        "Codex isn't signed in, so W1 runs on Claude. Run codex login in Terminal to use Codex."
    })
  ).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 45_000 })
  // No Codex thread was started for it.
  expect(readCodexLog(r).filter((l) => 'thread' in l)).toEqual([])
})

test('2.7: Codex not installed shows in Settings with how to install it, and the brain choice offers no Codex models', async () => {
  const r = await setup()
  const { page } = r
  // Codex worked and its models were remembered; then the user uninstalls it and opens Arc again.
  await openSettings(page)
  await expect(status(page)).toHaveText('Codex · signed in')
  await expect(
    page.getByLabel('Default brain').locator('option', { hasText: 'Fake Deep' })
  ).toHaveCount(1)
  await closeSettings(page)
  r.uninstallCodex()
  await r.relaunch()
  const again = r.page

  await openSettings(again)
  await expect(status(again)).toHaveText('Codex · not installed')
  await expect(providerRow(again, 'codex')).toContainText('npm install -g @openai/codex')
  await expect(
    providerRow(again, 'codex').getByRole('button', { name: 'Check Codex again' })
  ).toBeVisible()
  await closeSettings(again)

  await again
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await startSession(again, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(again.getByText('Ready when you are.').first()).toBeVisible()
  await again.getByRole('button', { name: 'Brain model' }).click()
  const menu = again.getByRole('menu', { name: 'Brain model' })
  await expect(menu.getByRole('group', { name: 'Claude', exact: true })).toBeVisible()
  await expect(menu.getByRole('group', { name: 'Codex', exact: true })).toHaveCount(0)
})

test('2.7: a Codex brain with Codex signed out replies from Claude · Sonnet and its card says so', async () => {
  const r = await setup()
  const { page } = r
  await setDefault(page, 'Default brain', 'Fake Deep')
  r.setCodex({ FAKE_CODEX_AUTH: 'signed_out' })
  await openSettings(page)
  await checkCodexAgain(page, 'Codex · not signed in')
  await closeSettings(page)

  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  // The reply comes from the (fake) Claude brain, and the card names the fallback.
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await expect(page.locator('[data-brain-model]')).toContainText('Claude (Codex unavailable)')
  expect(readCodexLog(r).filter((l) => 'thread' in l)).toEqual([])
})

test('2.7: after signing in to Codex in Terminal, Check again changes Settings to Codex · signed in', async () => {
  const r = await setup({ codex: { FAKE_CODEX_AUTH: 'signed_out' } })
  const { page } = r
  await openSettings(page)
  await expect(status(page)).toHaveText('Codex · not signed in')
  await expect(providerRow(page, 'codex').locator('[data-provider-command]')).toContainText(
    'codex login'
  )
  // The user runs `codex login` in Terminal.
  r.setCodex({ FAKE_CODEX_AUTH: 'ok' })
  await checkCodexAgain(page, 'Codex · signed in')
  await expect(providerRow(page, 'codex').locator('[data-provider-command]')).toHaveCount(0)
})
