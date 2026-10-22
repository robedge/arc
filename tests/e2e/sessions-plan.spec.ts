// @spec: 003-sessions-brain-and-workers
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
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

async function chooseFromMenu(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('button', { name: menu }).click()
  await page.getByRole('menuitemradio', { name: item }).click()
}

test('2.5: plan card lists the workers, a model choice sticks, nothing runs before Approve', async () => {
  rig = await launchRig({ scenario: 'plan-first' })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!])
  await startSession(page, { request: 'Add retries and docs' })

  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan).toBeVisible()
  const workers = plan.locator('[data-plan-worker]')
  await expect(workers).toHaveCount(2)
  await expect(workers.nth(0)).toContainText('api-retry')
  await expect(workers.nth(0)).toContainText('Add retry to the API client')
  await expect(workers.nth(0)).toContainText('api')
  await expect(workers.nth(1)).toContainText('docs-update')
  await expect(workers.nth(1)).toContainText('Document the retry option')
  await expect(workers.nth(1)).toContainText('web')
  await expect(plan.getByLabel('Model for api-retry')).toHaveValue('sonnet')
  // Nothing runs before approval.
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)

  // The user's model choice wins over the brain's.
  await plan.getByLabel('Model for docs-update').selectOption('haiku')
  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(page.locator('[data-plan-card="approved"]')).toBeVisible()
  await expect(workerCard(page, 'docs-update').locator('[data-worker-model]')).toHaveText(
    'Claude · Haiku'
  )
  await expect(workerCard(page, 'api-retry').locator('[data-worker-model]')).toHaveText(
    'Claude · Sonnet'
  )
})

test('2.5: Ask for changes replaces the plan; a header worker model overrides every worker', async () => {
  rig = await launchRig({ scenario: 'plan-changes' })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!])
  await startSession(page, { request: 'Add retries' })

  const first = page.locator('[data-plan-card="proposed"]')
  await expect(first.locator('[data-plan-worker]')).toHaveCount(2)
  await first.getByRole('button', { name: 'Ask for changes' }).click()
  await expect(page.getByPlaceholder('Message the brain')).toBeFocused()
  await page.getByPlaceholder('Message the brain').fill('Use one worker, not two')
  await page.getByPlaceholder('Message the brain').press('Enter')

  // A new plan arrives; the old card is Replaced with its buttons disabled.
  const replaced = page.locator('[data-plan-card="replaced"]')
  await expect(replaced).toBeVisible()
  await expect(replaced.locator('[data-plan-tag]')).toHaveText('Replaced')
  for (const name of ['Approve', 'Ask for changes', 'Reject']) {
    await expect(replaced.getByRole('button', { name })).toBeDisabled()
  }
  const current = page.locator('[data-plan-card="proposed"]')
  await expect(current.locator('[data-plan-worker]')).toHaveCount(1)

  // With one worker model set in the header, every worker on the plan card uses it.
  await chooseFromMenu(page, 'Worker model', 'Haiku')
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Haiku/i)
  await expect(current.getByLabel('Model for api-retry')).toHaveValue('haiku')
  await expect(current.getByLabel('Model for api-retry')).toBeDisabled()
})

test('2.5: Reject starts no workers and marks the card Rejected', async () => {
  rig = await launchRig({ scenario: 'plan-reject' })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!])
  await startSession(page, { request: 'Add retries' })

  const plan = page.locator('[data-plan-card="proposed"]')
  await plan.getByRole('button', { name: 'Reject' }).click()
  const rejected = page.locator('[data-plan-card="rejected"]')
  await expect(rejected.locator('[data-plan-tag]')).toHaveText('Rejected')
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
  await expect(page.getByText('Understood, I will not start any workers.')).toBeVisible()
})

test('2.5: changing the brain model mid-reply lets the reply finish, then the next reply uses it', async () => {
  rig = await launchRig({ scenario: 'slow-brain', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Explain the orders report' })

  const brain = page.locator('[data-brain-card]')
  await expect(brain).toHaveAttribute('data-state', 'thinking')
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Brain · Sonnet/i)
  await chooseFromMenu(page, 'Brain model', 'Opus')
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Brain · Opus/i)

  // The reply in progress finishes on the old model.
  await expect(page.getByText('Almost there. Done.').first()).toBeVisible({ timeout: 20_000 })
  await expect(brain).toHaveAttribute('data-state', 'idle')
  const starts = (): Record<string, unknown>[] =>
    readFakeLog(rig!).filter((r) => {
      const argv = r['argv']
      // the command probe (-p without a model) also starts the CLI
      return Array.isArray(argv) && argv.includes('-p') && argv.includes('--model')
    })
  const models = (r: Record<string, unknown>): string => {
    const argv = r['argv'] as string[]
    return argv[argv.indexOf('--model') + 1] ?? ''
  }
  const firstRun = starts()[0]!
  expect(models(firstRun)).toMatch(/sonnet/i)

  // The next reply comes from Opus, resuming the earlier conversation.
  await page.getByPlaceholder('Message the brain').fill('And the second question')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect.poll(() => starts().length).toBeGreaterThan(1)
  const next = starts().at(-1)!
  expect(models(next)).toMatch(/opus/i)
  const argv = next['argv'] as string[]
  expect(argv).toContain('--resume')
  expect(argv[argv.indexOf('--resume') + 1]).toMatch(/^[0-9a-f-]{36}$/)
})

test('2.5: switching to Autonomous keeps running workers and later workers start without a plan card', async () => {
  rig = await launchRig({ scenario: 'mode-switch', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Do two things then more' })

  await page.locator('[data-plan-card="proposed"]').getByRole('button', { name: 'Approve' }).click()
  await expect(workerCard(page, 'first-a')).toHaveAttribute('data-worker-card', 'working')
  await expect(workerCard(page, 'first-b')).toHaveAttribute('data-worker-card', 'working')

  await chooseFromMenu(page, 'Mode and worker limit', 'Autonomous')
  await expect(page.getByRole('button', { name: 'Mode and worker limit' })).toHaveText(
    /Autonomous/i
  )
  await expect(workerCard(page, 'first-a')).toHaveAttribute('data-worker-card', 'working')

  const plansBefore = await page.locator('[data-plan-card]').count()
  await page.getByPlaceholder('Message the brain').fill('SPAWN-MORE')
  await page.getByPlaceholder('Message the brain').press('Enter')
  await expect(workerCard(page, 'second-a')).toBeVisible()
  await expect(workerCard(page, 'second-b')).toBeVisible()
  expect(await page.locator('[data-plan-card]').count()).toBe(plansBefore)
  await expect(page.locator('[data-plan-card="proposed"]')).toHaveCount(0)
})
