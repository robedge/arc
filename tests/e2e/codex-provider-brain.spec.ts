// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import { launchCodexRig } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { flag, sessionStarts } from './commands-rig'
import {
  createGroupWithProjects,
  eventLog,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'

/**
 * Spec 007 sections 2.2 and 2.3.
 *
 * A scripted brain cannot choose a provider "when it suits the task": 2.2's first criterion is a model behaviour. The
 * test below checks the plumbing that makes it possible. The brain's tool call names `provider: "codex"`, and the
 * app starts the worker on Codex, shows it and logs it. Whether a real brain makes that call is not tested.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('2.2 + 2.3: with Workers on Auto a Codex worker is started next to a Claude worker; both cards and the log name provider and model', async () => {
  rig = await launchCodexRig({
    scenario: 'cx-second-opinion',
    codexScenario: 'cx-spawn',
    repos: [{ name: 'api' }]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Auto/i)
  const w1 = workerCard(page, 'W1 · api-retry')
  await expect(w1.locator('[data-worker-model]')).toHaveText('Claude · Sonnet')
  await expect(page.getByText('W1 is running.')).toBeVisible()

  // What the app does to make the choice possible: the brain is told it may pick Codex and when.
  const brainStart = sessionStarts(readFakeLog(rig)).find((argv) =>
    (flag(argv, '--append-system-prompt') ?? '').includes('arc-role:brain')
  )
  expect(flag(brainStart ?? [], '--append-system-prompt')).toContain(
    'Choose Codex for a review, for a second opinion on another worker'
  )

  await page
    .getByPlaceholder('Message the brain')
    .fill("get a second opinion from Codex on W1's change")
  await page.getByPlaceholder('Message the brain').press('Enter')

  // The brain's reply names Codex and says why.
  await expect(page.getByText(/I started W2 on Codex for a second opinion/)).toBeVisible()
  // 2.3: the worker list shows each worker's provider and model.
  const w2 = workerCard(page, 'W2 · review')
  await expect(w2.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(w1.locator('[data-worker-model]')).toHaveText('Claude · Sonnet')
  // 2.3: the event log names the worker with its provider and model.
  await expect(
    eventLog(page).filter({ hasText: 'started W2 review · Codex · fake-deep' })
  ).toHaveCount(1)
  await expect(
    eventLog(page).filter({ hasText: 'started W1 api-retry · Claude · Sonnet' })
  ).toHaveCount(1)
})

test('2.2: in Plan-first the plan card shows the provider and model, and changing a worker to Codex before Approve makes its card Codex', async () => {
  rig = await launchCodexRig({
    scenario: 'cx-plan',
    codexScenario: 'cx-spawn',
    repos: [{ name: 'api' }]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Add retry' })

  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan).toBeVisible()
  await expect(plan.locator('[data-plan-provider]')).toHaveText('Claude · Sonnet')
  await expect(plan.getByLabel('Provider for api-retry')).toHaveValue('claude')
  await plan.getByLabel('Provider for api-retry').selectOption('codex')
  await expect(plan.getByLabel('Model for api-retry')).toHaveValue('fake-deep')
  await plan.getByRole('button', { name: 'Approve' }).click()

  await expect(page.locator('[data-plan-card="approved"]')).toBeVisible()
  await expect(workerCard(page, 'W1 · api-retry').locator('[data-worker-model]')).toHaveText(
    'Codex · fake-deep'
  )
  await expect(
    eventLog(page).filter({ hasText: 'started W1 api-retry · Codex · fake-deep' })
  ).toHaveCount(1)
})
