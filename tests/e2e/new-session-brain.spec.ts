// @spec: 003-sessions-brain-and-workers
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, launchRig } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('the New session dialog picks the brain, and the next dialog remembers it', async () => {
  rig = await launchRig({
    scenario: 'titled-fix-order-sync.jsonl',
    repos: [{ name: 'api', kind: 'clean' }]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])

  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New session' })
  const brain = dialog.getByLabel('Brain', { exact: true })
  await expect(brain).toHaveValue('claude:sonnet')
  await brain.selectOption('claude:opus')
  await dialog.getByLabel('Request').fill('Why is the orders report slow?')
  await page.screenshot({ path: 'docs/screenshots/new-session-brain-picker.png' })
  await dialog.getByRole('button', { name: 'Start' }).click()

  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Opus/)

  // Back to the list: a new dialog starts on the remembered brain.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await page.getByRole('button', { name: 'New Session', exact: true }).click()
  await expect(
    page.getByRole('dialog', { name: 'New session' }).getByLabel('Brain', { exact: true })
  ).toHaveValue('claude:opus')
})
