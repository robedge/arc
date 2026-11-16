// @spec: 015-skip-all-approvals
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createGroupWithProjects, launchRig } from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 015 slice 3: Skip all approvals as the default. Turned on in Settings through the warning dialog, shown in
 * the New Session dialog, kept off for one session, on for another, marked in the header and the list, and kept
 * across a restart with no dialog. Fake CLIs only.
 */

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const warning = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const headerMarker = (page: Page) => page.locator('[data-skip-approvals-on]')
const listMarkers = (page: Page) => page.locator('[data-session-row] [data-session-skip-marker]')
const skippingRow = (page: Page) =>
  page.locator('[data-session-row]').filter({ has: page.locator('[data-session-skip-marker]') })
const plainRow = (page: Page) =>
  page.locator('[data-session-row]').filter({ hasNot: page.locator('[data-session-skip-marker]') })
const rows = (page: Page) => page.locator('[data-session-row]')

async function openApprovalsSettings(page: Page): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings' }).click()
  }
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Approvals' }).click()
  await expect(page.getByRole('heading', { name: 'Approvals' })).toBeVisible()
}

async function openSessions(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
}

test('015 2.2/2.3/2.6: the default through Settings, a session without it, one with it, kept after a restart with no dialog', async () => {
  rig = await launchRig({ scenario: 'autonomous', repos: [{ name: 'api' }] })
  const r = rig
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])

  // Settings > Approvals: turning the default on asks first, and Escape does not turn it on.
  await openApprovalsSettings(page)
  const defaultSwitch = page.getByLabel('Skip all approvals by default')
  await expect(defaultSwitch).not.toBeChecked()
  await defaultSwitch.click()
  await expect(warning(page)).toBeVisible()
  await expect(warning(page)).toContainText(
    'Every new session will start with Skip all approvals on.'
  )
  await expect(defaultSwitch).not.toBeChecked()
  await warning(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(warning(page)).toHaveCount(0)
  await expect(defaultSwitch).toBeChecked()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-settings]')).toHaveCount(0)

  // New Session dialog: the switch starts on. Escape in its warning dialog keeps it open (real Electron).
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  const sessionSwitch = dialog.getByLabel('Skip all approvals', { exact: true })
  await expect(sessionSwitch).toBeChecked()
  await sessionSwitch.click() // off, no dialog
  await expect(warning(page)).toHaveCount(0)
  await expect(sessionSwitch).not.toBeChecked()
  await sessionSwitch.click() // back on: the warning stacks above
  await expect(warning(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(warning(page)).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await expect(sessionSwitch).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)

  // Reopening starts from the default again (on); turn it off and start: no marker anywhere.
  await page.getByRole('button', { name: 'New Session' }).click()
  await expect(sessionSwitch).toBeChecked()
  await sessionSwitch.click()
  await expect(sessionSwitch).not.toBeChecked()
  await dialog.getByLabel('Request').fill('First without skipping')
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
  await expect(headerMarker(page)).toHaveCount(0)
  await expect(listMarkers(page)).toHaveCount(0)
  await openApprovalsSettings(page)
  await expect(page.getByLabel('Skip all approvals by default')).toBeChecked()
  await page.getByRole('button', { name: 'Back' }).click()

  // A second session with the switch left on (from the default): no dialog, marker on that row only.
  await openSessions(page)
  await page.getByRole('button', { name: 'New Session', exact: true }).click()
  await expect(sessionSwitch).toBeChecked()
  await dialog.getByLabel('Request').fill('Second with skipping')
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await expect(warning(page)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(page.locator('[data-brain-card]')).toHaveAttribute('data-state', 'idle', {
    timeout: 30_000
  })
  await expect(headerMarker(page)).toBeVisible()
  await openSessions(page)
  await expect(rows(page)).toHaveCount(2)
  await expect(listMarkers(page)).toHaveCount(1)
  await expect(skippingRow(page)).toHaveCount(1)
  await expect(plainRow(page)).toHaveCount(1)
  await page.keyboard.press('Escape')

  // Quit and relaunch with the same user data: the session keeps it, with the marker and no dialog.
  await r.relaunch()
  await r.page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await expect(rows(r.page)).toHaveCount(2)
  await expect(listMarkers(r.page)).toHaveCount(1)
  await skippingRow(r.page).click()
  await expect(headerMarker(r.page)).toBeVisible()
  await expect(warning(r.page)).toHaveCount(0)
  // The switch itself is on too (the Approvals popover), still with no dialog.
  await r.page.getByRole('button', { name: 'Approvals', exact: true }).click()
  await expect(r.page.getByLabel('Skip all approvals', { exact: true })).toBeChecked()
  await expect(warning(r.page)).toHaveCount(0)
  await r.page.keyboard.press('Escape')
  await openSessions(r.page)
  await plainRow(r.page).click()
  await expect(r.page.locator('[data-session-screen]')).toBeVisible()
  await expect(headerMarker(r.page)).toHaveCount(0)
})
