// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  chooseFromMenu,
  closeSettings,
  launchCodexRig,
  openSettings,
  readCodexLog
} from './codex-rig'
import type { CodexRig } from './codex-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'
import { codexTurns } from './codex-rig'

/**
 * Spec 007 sections 2.1 and 2.4 (merge), driven through the built app with the fake Claude CLI and the fake Codex
 * app-server. No model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function setup(): Promise<CodexRig> {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'cx-spawn',
    repos: [{ name: 'api' }]
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  return r
}

/** Settings > Providers > Default workers. */
async function setDefaultWorkers(page: Page, label: string): Promise<void> {
  await openSettings(page)
  await page.getByLabel('Default workers').selectOption({ label })
  await expect(page.getByLabel('Default workers').locator('option:checked')).toHaveText(label)
  await closeSettings(page)
}

const workersButton = (page: Page) => page.getByRole('button', { name: 'Worker model' })

test('2.1 + 2.4: Settings says Codex, so the header says Workers · Codex, the worker runs on Codex and its work is merged', async () => {
  const r = await setup()
  const { page } = r
  await setDefaultWorkers(page, 'Codex')

  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(workersButton(page)).toHaveText(/Workers · Codex/i)
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(
    eventLog(page).filter({ hasText: 'started W1 review · Codex · fake-deep' })
  ).toHaveCount(1)

  // 2.4: the Codex worker's change is merged by itself and Review changes lists the file with the worker's name.
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 45_000 })
  await expect(page.getByText('Summary: hello.txt was patched.')).toBeVisible()
  await page
    .locator('[data-session-screen]')
    .getByRole('button', { name: /^Review changes · 1$/ })
    .click()
  const row = page.locator('[data-review-file="hello.txt"]')
  await expect(row).toBeVisible()
  await expect(row.locator('[data-workers]')).toHaveText(/W1/)
})

test('2.1: a Workers choice in the header beats a Codex default in Settings', async () => {
  const r = await setup()
  const { page } = r
  await setDefaultWorkers(page, 'Codex')

  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(workersButton(page)).toHaveText(/Workers · Codex/i)
  await chooseFromMenu(page, 'Worker model', 'Claude')
  await expect(workersButton(page)).toHaveText(/Workers · Claude/i)
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Claude · /)
  await expect(eventLog(page).filter({ hasText: /started W1 review · Claude · / })).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 45_000 })
  // No Codex thread was ever started.
  expect(readCodexLog(r).filter((l) => 'thread' in l)).toEqual([])
})

test('2.1: the brain model choice lists Claude and Codex models, each under its provider', async () => {
  const r = await setup()
  const { page } = r
  await startSession(page, { request: 'Patch hello', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.').first()).toBeVisible()
  await page.getByRole('button', { name: 'Brain model' }).click()
  const menu = page.getByRole('menu', { name: 'Brain model' })
  const claude = menu.getByRole('group', { name: 'Claude', exact: true })
  const codex = menu.getByRole('group', { name: 'Codex', exact: true })
  await expect(claude.getByRole('menuitemradio')).toHaveCount(3)
  await expect(claude.getByRole('menuitemradio', { name: 'Sonnet' })).toBeVisible()
  await expect(codex.getByRole('menuitemradio')).toHaveCount(2)
  await expect(codex.getByRole('menuitemradio').first()).toContainText('Fake Deep')
  // Cursor is ready in this rig, so its maker groups sit under their own names, apart from the Claude group.
  await expect(menu.getByRole('group', { name: 'Cursor · Claude', exact: true })).toBeVisible()
})

test('2.1: switching the brain to a Codex model while it replies lets the reply finish, then the next reply comes from Codex', async () => {
  const r = await launchCodexRig({
    scenario: 'slow-brain',
    codexScenario: 'cx-newmodel',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Explain the orders report' })

  const brain = page.locator('[data-brain-card]')
  await expect(brain).toHaveAttribute('data-state', 'thinking')
  await chooseFromMenu(page, 'Brain model', 'Fake Deep')
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(
    /Brain · Codex Fake Deep/i
  )

  // The reply in progress finishes on Claude; no Codex thread has started.
  await expect(page.getByText('Almost there. Done.').first()).toBeVisible({ timeout: 20_000 })
  await expect(brain).toHaveAttribute('data-state', 'idle')
  expect(codexTurns(r)).toEqual([])

  // The next reply comes from the Codex model.
  await page.getByPlaceholder('Message the brain').fill('And the second question')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect(page.getByText('Hello from the new model.')).toBeVisible()
  await expect(page.locator('[data-brain-model]')).toHaveText('Codex · fake-deep')
  expect(codexTurns(r).at(-1)?.model).toBe('fake-deep')
})
