// @spec: 010-cursor-as-a-third-provider
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchCodexRig, openSettings, providerRow } from './codex-rig'
import type { CodexRig } from './codex-rig'

/** Spec 010 slice 1: Settings > Providers shows Cursor in each state. The fake Cursor makes no model call. */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const status = (page: Page) => providerRow(page, 'cursor').locator('[data-provider-status]')

async function setup(options: { installed?: boolean; cursor?: Record<string, string> } = {}) {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    repos: [{ name: 'api' }],
    cursorInstalled: options.installed ?? true,
    cursor: options.cursor ?? {}
  })
  rig = r
  await openSettings(r.page)
  return r
}

test('Cursor signed in shows its version', async () => {
  const r = await setup({ cursor: { FAKE_CURSOR_VERSION: '2026.10.19-6bbf2c4' } })
  await expect(status(r.page)).toHaveText('Cursor · signed in')
  await expect(providerRow(r.page, 'cursor').locator('[data-provider-version]')).toHaveText(
    '2026.10.19-6bbf2c4'
  )
  await expect(providerRow(r.page, 'claude')).toBeVisible()
  await expect(providerRow(r.page, 'codex')).toBeVisible()
})

test('Cursor not signed in shows the login command, and Check again picks up the sign-in', async () => {
  const r = await setup({ cursor: { FAKE_CURSOR_AUTH: 'signed_out' } })
  await expect(status(r.page)).toHaveText('Cursor · not signed in')
  await expect(providerRow(r.page, 'cursor').locator('[data-provider-command]')).toContainText(
    'agent login'
  )
  r.setCursor({ FAKE_CURSOR_AUTH: 'ok' })
  await providerRow(r.page, 'cursor').getByRole('button', { name: 'Check Cursor again' }).click()
  await expect(status(r.page)).toHaveText('Cursor · signed in')
  await expect(providerRow(r.page, 'cursor').locator('[data-provider-command]')).toHaveCount(0)
})

test('Cursor not installed shows how to install it', async () => {
  const r = await setup({ installed: false })
  await expect(status(r.page)).toHaveText('Cursor · not installed')
  await expect(providerRow(r.page, 'cursor')).toContainText(
    'curl https://cursor.com/install -fsS | bash'
  )
  await expect(
    providerRow(r.page, 'cursor').getByRole('button', { name: 'Check Cursor again' })
  ).toBeVisible()
})
