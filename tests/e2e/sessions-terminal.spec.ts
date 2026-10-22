// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import {
  createGroupWithProjects,
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

test('2.9: worker terminal tabs show live output, close, Details and watch-only typing', async () => {
  rig = await launchRig({ scenario: 'v9-slow' })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!])
  await startSession(page, { request: 'Retry everywhere', mode: 'Autonomous' })

  const tabs = page.getByRole('tablist', { name: 'Conversation' })
  const api = workerCard(page, 'W1 · api-retry')
  const web = workerCard(page, 'W2 · web-retry')
  await expect(api).toHaveAttribute('data-worker-card', 'working')
  await expect(web).toHaveAttribute('data-worker-card', 'working')
  await expect(tabs.getByRole('tab')).toHaveText(['Brain'])

  // The small Details button opens the details and no terminal tab.
  await page.getByRole('button', { name: 'Details for W2 · web-retry' }).click()
  await expect(page.getByRole('dialog', { name: 'W2 · web-retry' })).toBeVisible()
  await expect(tabs.getByRole('tab')).toHaveText(['Brain'])
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()

  // Clicking the card opens its terminal in a tab next to Brain and new lines keep arriving.
  await api.getByRole('button').first().click()
  await expect(tabs.getByRole('tab')).toHaveText(['Brain', 'W1 · api-retry'])
  await expect(tabs.getByRole('tab', { name: 'W1 · api-retry' })).toHaveAttribute(
    'aria-selected',
    'true'
  )
  const log = page.getByRole('log', { name: 'W1 · api-retry output' })
  await expect(log.getByText('Step 1 of 10', { exact: false })).toBeVisible()
  const lines = log.locator('[data-terminal-line]')
  const countBefore = await lines.count()
  await expect.poll(async () => lines.count(), { timeout: 8000 }).toBeGreaterThan(countBefore)

  // Clicking the card again switches to the existing tab instead of opening another.
  await page.getByRole('tab', { name: 'Brain' }).click()
  await api.getByRole('button').first().click()
  await expect(tabs.getByRole('tab')).toHaveText(['Brain', 'W1 · api-retry'])

  // Typing into the terminal sends nothing to the worker.
  const stdinCount = (): number => readFakeLog(rig!).filter((r) => 'stdin' in r).length
  const before = stdinCount()
  await log.click()
  await page.keyboard.type('rm -rf everything')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  expect(stdinCount()).toBe(before)
  await expect(page.getByText('rm -rf everything')).toHaveCount(0)

  // Two tabs: Brain shows the conversation again; closing one tab leaves the other.
  await web.getByRole('button').first().click()
  await expect(tabs.getByRole('tab')).toHaveText(['Brain', 'W1 · api-retry', 'W2 · web-retry'])
  await tabs.getByRole('tab', { name: 'Brain' }).click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  await tabs.getByRole('tab', { name: 'W1 · api-retry' }).click()
  await page.getByRole('button', { name: 'Close W1 · api-retry' }).click()
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible()
  await expect(tabs.getByRole('tab')).toHaveText(['Brain', 'W2 · web-retry'])

  // A finished worker shows its whole output from start to finish.
  await expect(workerCard(page, 'W1 · api-retry')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 30_000
  })
  await workerCard(page, 'W1 · api-retry').getByRole('button').first().click()
  const finished = page.getByRole('log', { name: 'W1 · api-retry output' })
  await expect(finished.getByText('Step 1 of 10', { exact: false })).toBeVisible()
  await expect(finished.getByText('Step 10 of 10', { exact: false })).toBeVisible()
  await expect(finished.getByText('Step 5 of 10', { exact: false })).toBeVisible()
})
