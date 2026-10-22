// @spec: 003-sessions-brain-and-workers
// @regression
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

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const TITLES = ['W1 · keeper-one', 'W2 · keeper-two', 'W3 · keeper-three']

async function reopen(page: Page): Promise<number> {
  const started = Date.now()
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-name]')).toHaveText('Three keepers')
  for (const title of TITLES) await expect(workerCard(page, title)).toBeVisible()
  await expect(page.getByText('Workers are running.')).toBeVisible()
  await expect(eventLog(page).filter({ hasText: 'started W3 keeper-three' })).toHaveCount(1)
  return Date.now() - started
}

function resumes(r: Rig): number {
  return readFakeLog(r).filter(
    (l) => Array.isArray(l['argv']) && (l['argv'] as string[]).includes('--resume')
  ).length
}

test('2.10: reopen after quit shows everything within 10 s, follow-ups keep context, Continue resumes workers', async () => {
  rig = await launchRig({ scenario: 'resume', repos: [{ name: 'api' }] })
  await createGroupWithProjects(rig, 'Storefront', [rig.repos['api']!])
  await startSession(rig.page, { request: 'Keep three workers busy', mode: 'Autonomous' })
  for (const title of TITLES) {
    await expect(workerCard(rig.page, title)).toHaveAttribute('data-worker-card', 'working')
  }

  await rig.relaunch({ scenario: 'resume-after' })
  const page = rig.page
  const elapsed = await reopen(page)
  expect(elapsed).toBeLessThan(10_000)
  expect(await page.locator('[data-message-role="user"]').first().innerText()).toBe(
    'Keep three workers busy'
  )

  // Workers are Stopped, with the clean-quit event, and the brain asks whether to continue.
  for (const title of TITLES) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'stopped')
  }
  await expect(eventLog(page).filter({ hasText: 'stopped when Arc quit' })).toHaveCount(3)
  const prompt = page.locator('[data-continue-prompt="open"]')
  await expect(prompt).toContainText('3 workers were stopped when Arc closed. Continue them?')

  // A follow-up question is answered by the brain resuming the earlier conversation.
  const before = resumes(rig)
  await page.getByPlaceholder('Message the brain').fill('What were we doing?')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect(page.getByText('I remember the earlier conversation.')).toBeVisible()
  expect(resumes(rig)).toBeGreaterThan(before)

  // Continue brings them back to Working with --resume.
  const beforeContinue = resumes(rig)
  await prompt.getByRole('button', { name: 'Continue' }).click()
  for (const title of TITLES) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'working')
  }
  expect(resumes(rig)).toBeGreaterThanOrEqual(beforeContinue + 3)
  await expect(page.locator('[data-continue-prompt="continued"]')).toBeVisible()
})

test('2.10: after a crash the event says so; Not now leaves them Stopped and each can be continued later', async () => {
  rig = await launchRig({ scenario: 'resume', repos: [{ name: 'api' }] })
  await createGroupWithProjects(rig, 'Storefront', [rig.repos['api']!])
  await startSession(rig.page, { request: 'Keep three workers busy', mode: 'Autonomous' })
  for (const title of TITLES) {
    await expect(workerCard(rig.page, title)).toHaveAttribute('data-worker-card', 'working')
  }

  await rig.crashAndRelaunch({ scenario: 'resume-after' })
  const page = rig.page
  await reopen(page)
  for (const title of TITLES) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'stopped')
  }
  await expect(
    eventLog(page).filter({ hasText: 'Stopped when Arc closed unexpectedly' })
  ).toHaveCount(3)
  const prompt = page.locator('[data-continue-prompt="open"]')
  await expect(prompt).toContainText('3 workers were stopped when Arc closed. Continue them?')

  // Not now: they stay Stopped.
  await prompt.getByRole('button', { name: 'Not now' }).click()
  await expect(page.locator('[data-prompt-outcome]')).toHaveText('Not now')
  for (const title of TITLES) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'stopped')
  }

  // One of them can still be continued from its own details.
  await page.getByRole('button', { name: 'Details for W2 · keeper-two' }).click()
  const dialog = page.getByRole('dialog', { name: 'W2 · keeper-two' })
  await dialog.getByRole('button', { name: 'Continue' }).click()
  await expect(workerCard(page, 'W2 · keeper-two')).toHaveAttribute('data-worker-card', 'working')
  await expect(workerCard(page, 'W1 · keeper-one')).toHaveAttribute('data-worker-card', 'stopped')
})
