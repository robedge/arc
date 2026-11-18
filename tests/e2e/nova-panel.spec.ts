// @spec: 016-voice-companion
// @regression
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, launchRig, sendToBrain, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'
import { closeReview, openReview, reviewButton } from './review-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('2.1: the Nova panel opens beside the conversation, closes, hides under the review and goes with the session', async () => {
  const r = await launchRig({ scenario: 'nova-panel', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  const novaButton = page.getByRole('button', { name: 'Nova', exact: true })
  const panel = page.locator('[data-nova-panel]')

  // With no session open there is no Nova button.
  await expect(novaButton).toHaveCount(0)

  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await expect(novaButton).toHaveCount(0)
  await startSession(page, { request: 'Say hello', mode: 'Autonomous' })
  await expect(page.locator('[data-session-screen]')).toBeVisible()

  // The button opens the panel with the portrait, the name and the Idle state.
  await expect(panel).toHaveCount(0)
  await expect(novaButton).toHaveAttribute('aria-pressed', 'false')
  await novaButton.click()
  await expect(novaButton).toHaveAttribute('aria-pressed', 'true')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('heading', { name: 'Nova' })).toBeVisible()
  await expect(panel.getByRole('status')).toHaveText('Idle')
  const portrait = panel.locator('[data-nova-portrait]')
  await expect(portrait).toBeVisible()
  await expect(portrait.locator('canvas, img')).toBeVisible()

  // The chat still works with the panel open.
  await sendToBrain(page, 'Hello with the panel open')
  await expect(page.getByText('Panel reply received.')).toBeVisible({ timeout: 30_000 })
  await expect(panel).toBeVisible()

  const dir = join(process.cwd(), 'docs', 'screenshots')
  await mkdir(dir, { recursive: true })
  await page.screenshot({ path: join(dir, 'nova-panel.png') })

  // The rest of the session screen stays usable: the chat keeps its width, whatever the window.
  const width = async (selector: string): Promise<number> =>
    page.locator(selector).evaluate((el) => el.getBoundingClientRect().width)
  const chat = '[data-session-body] > div:first-child'
  const composer = '[data-session-body] textarea'
  const brainColumn = page.locator('[data-session-body] > div').nth(1)
  const resize = async (w: number, h: number): Promise<void> => {
    await r.app.evaluate(
      ({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows()[0]!
        win.setMinimumSize(300, 300)
        win.setSize(size[0]!, size[1]!)
      },
      [w, h]
    )
  }
  expect(await width(chat)).toBeGreaterThanOrEqual(480)
  expect(await width(composer)).toBeGreaterThanOrEqual(300)
  expect(await width('[data-nova-panel]')).toBeGreaterThanOrEqual(240)

  await resize(1100, 800)
  await expect(brainColumn).toBeHidden()
  expect(await width(chat)).toBeGreaterThanOrEqual(480)
  expect(await width('[data-nova-panel]')).toBeGreaterThanOrEqual(240)

  await resize(1700, 1000)
  await expect(brainColumn).toBeVisible()
  expect(await width(chat)).toBeGreaterThanOrEqual(480)
  expect(await width('[data-nova-panel]')).toBeGreaterThanOrEqual(240)

  await resize(1100, 800)
  await expect(brainColumn).toBeHidden()
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(brainColumn).toBeVisible()
  await novaButton.click()
  await resize(1280, 800)

  // Wait for the worker's merged change, so Review changes is enabled.
  await expect(reviewButton(page)).not.toHaveAttribute('aria-disabled', 'true', { timeout: 60_000 })

  // The review hides the panel, and closing the review shows it again.
  await openReview(page)
  await expect(panel).toBeHidden()
  await closeReview(page)
  await expect(panel).toBeVisible()

  // Close removes the column.
  await panel.getByRole('button', { name: 'Close' }).click()
  await expect(panel).toHaveCount(0)
  await expect(novaButton).toHaveAttribute('aria-pressed', 'false')

  // Switching session closes the panel.
  await novaButton.click()
  await expect(panel).toBeVisible()
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await expect(novaButton).toHaveCount(0)
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
  await expect(panel).toHaveCount(0)
  await expect(novaButton).toHaveAttribute('aria-pressed', 'false')
})
