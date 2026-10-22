// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { closeSettings, launchCodexRig, openSettings, providerRow } from './codex-rig'
import type { CodexRig } from './codex-rig'

/**
 * Spec 007 section 2.8, the update notice and the Providers page. The newest published version comes from a file
 * (HARNESS_PROVIDER_LATEST_FILE), never the npm registry; the installed version is whatever the fake Codex prints.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const notice = (page: Page) => page.locator('[data-update-notice="codex"]')

test('2.8: a newer Codex shows on the Providers page with both versions and the command, and a notice once; dismissed, it stays away', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    repos: [{ name: 'api' }],
    codex: { FAKE_CODEX_VERSION: '0.162.1' },
    latest: { codex: '0.170.0' }
  })
  rig = r
  const { page } = r

  // The notice appears on its own when Arc opens.
  await expect(notice(page)).toContainText('Codex 0.170.0 is available')
  await expect(notice(page)).toContainText('codex update')
  await expect(page.getByRole('button', { name: 'Copy codex update' })).toBeVisible()

  // The Providers page shows both versions, the command and a copy button.
  await openSettings(page)
  const update = providerRow(page, 'codex').locator('[data-provider-update]')
  await expect(update).toContainText('Update available: 0.162.1 → 0.170.0')
  await expect(update.locator('[data-provider-update-command]')).toHaveText('codex update')
  await expect(update.getByRole('button', { name: /Copy/ })).toBeVisible()

  // Dismiss it: the notice goes, the page keeps the update.
  await page.getByRole('button', { name: 'Dismiss Codex update notice' }).click()
  await expect(notice(page)).toHaveCount(0)
  await expect(update).toBeVisible()
  await closeSettings(page)

  // Reopen Arc with the same version waiting: no notice, but the page still shows the update.
  await r.relaunch()
  await openSettings(r.page)
  await expect(providerRow(r.page, 'codex').locator('[data-provider-update]')).toContainText(
    'Update available: 0.162.1 → 0.170.0'
  )
  await expect(notice(r.page)).toHaveCount(0)

  // A later version is a new notice.
  r.setLatest({ codex: '0.171.0' })
  await providerRow(r.page, 'codex').getByRole('button', { name: 'Check Codex again' }).click()
  await expect(notice(r.page)).toContainText('Codex 0.171.0 is available')
})
