// The brain's dashboard panel: it shows in the conversation, a click sends the user's answer back,
// and the panel stays usable afterwards.
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, launchRig, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

test.setTimeout(120_000)

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('a brain panel shows in the conversation; a click adds a Clicked message and the panel stays usable', async () => {
  rig = await launchRig({ scenario: 'surface-panel', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Show me the release panel' })

  const panel = page.locator('[data-surface]')
  const bubble = page.locator('[data-message-role]:has([data-surface])')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Release 2.4')).toBeVisible()
  await expect(panel.getByText('Deploys')).toBeVisible()
  await expect(bubble).toHaveCount(1)

  await panel.getByRole('button', { name: 'Deploy' }).click()
  const clicked = page.locator('[data-message-role="user"] [data-surface-action]')
  await expect(clicked).toHaveCount(1)
  await expect(clicked).toContainText('Clicked')
  await expect(clicked).toContainText('Clicked Deploy')
  await expect(
    page.locator('[data-message-role="user"]').filter({ hasText: 'env:' })
  ).toContainText('staging')

  await expect(bubble.getByText('Last sent: Deploy')).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Deploy' })).toBeEnabled()
  await expect(page.getByText('Got the click.')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('surface.png') })
})

test('request parts: code expands, the key-value list shows, and the button waits for a choice', async () => {
  rig = await launchRig({ scenario: 'surface-request-parts', repos: [{ name: 'api' }] })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Show me the parts panel' })

  const panel = page.locator('[data-surface]')
  await expect(panel.getByText('Parts panel')).toBeVisible()

  const code = panel.locator('[data-code]')
  await expect(code).toContainText('line 10')
  await expect(code).not.toContainText('line 11')
  await panel.getByRole('button', { name: 'Show more' }).click()
  await expect(code).toContainText('line 30')
  await expect(panel.getByRole('button', { name: 'Show less' })).toHaveAttribute(
    'aria-label',
    'Show less'
  )
  await panel.getByRole('button', { name: 'Show less' }).click()
  await expect(code).not.toContainText('line 11')

  for (const text of ['Command', 'pnpm test', 'Files', 'a.ts', 'b.ts']) {
    await expect(panel.getByText(text, { exact: true })).toBeVisible()
  }

  const go = panel.getByRole('button', { name: 'Continue' })
  await expect(go).toBeDisabled()
  await expect(panel.getByText('Keep them')).toBeVisible()
  await panel.getByRole('radio', { name: /Bring along/ }).check()
  await expect(go).toBeEnabled()

  await go.click()
  const clicked = page.locator('[data-message-role="user"] [data-surface-action]')
  await expect(clicked).toHaveCount(1)
  await expect(clicked).toContainText('Clicked')
  await expect(
    page.locator('[data-message-role="user"]').filter({ hasText: 'choice' })
  ).toContainText('carry')
  await expect(page.getByText('Got the choice.')).toBeVisible()
})
