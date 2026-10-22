// @spec: 005-commands-and-skills-in-sessions
// @regression
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { createGroupWithProjects, launchRig, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'
import { commandMenu, commandOption, composer, makeFakeHome } from './commands-rig'
import type { FakeHome } from './commands-rig'

// Settings > Plugins against a fake HOME with a fake plugin cache and the fake CLI's `claude plugin` branch.
// One Arc run shares the list, install, update and remove tests; each works on a plugin of its own, so none
// depends on another. The failing install needs a different CLI switch, so it launches its own run.
test.setTimeout(120_000)

let rig: Rig
let home: FakeHome
test.beforeAll(async () => {
  home = await makeFakeHome({
    plugins: [
      {
        name: 'alpha',
        version: '2.1.0',
        description: 'Alpha helpers for specs',
        commands: { a1: 'First alpha command', a2: 'Second alpha command' },
        skills: ['planning'],
        hooks: true,
        mcp: true
      },
      { name: 'beta', version: '1.0.0', latest: '1.0.1', commands: { b1: 'Beta command' } },
      { name: 'gamma', version: '1.0.0', commands: { g1: 'Gamma command' } }
    ]
  })
  rig = await launchRig({
    scenario: 'cmd-menu',
    repos: [{ name: 'api' }],
    env: { ...home.env, FAKE_CLAUDE_PLUGIN_DELAY: '1500' }
  })
  await createGroupWithProjects(rig, 'Storefront', [rig.repos['api']!])
  await startSession(rig.page, { request: 'Plan retry settings', mode: 'Autonomous' })
  await expect(rig.page.locator('[data-session-screen]')).toBeVisible()
  await expect(rig.page.getByText('Ready.').first()).toBeVisible()
})
test.afterAll(async () => {
  await rig?.dispose()
  await home?.dispose()
})

const row = (page: Page, id: string): Locator => page.locator(`[data-plugin="${id}@fake-market"]`)

async function openPlugins(page: Page): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings' }).click()
  }
  // Settings opens on Providers; pick the Plugins page.
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Plugins' }).click()
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Installed plugins' })).toBeVisible()
}

async function backToSession(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
}

test('2.6: Settings > Plugins lists the installed plugins with version, description, source and counts', async () => {
  const { page } = rig
  await openPlugins(page)
  await expect(page.getByText('Changes apply to agents started afterwards.')).toBeVisible()
  await expect(
    page.getByText('same plugins Claude Code uses in the terminal', { exact: false })
  ).toBeVisible()

  const alpha = row(page, 'alpha')
  await expect(alpha.getByRole('heading', { name: 'alpha' })).toBeVisible()
  await expect(alpha).toContainText('2.1.0')
  await expect(alpha).toContainText('Alpha helpers for specs')
  await expect(alpha).toContainText('fake-market')
  await expect(alpha.getByText('fake-market')).toHaveAttribute('title', 'fake/market')
  await expect(alpha.locator('[data-counts]')).toHaveText('2 commands · 1 skill')
  // alpha ships an MCP server and hooks; Arc agents load both, so there is no badge for them.
  await expect(alpha.locator('[data-badge]')).toHaveCount(0)
  await expect(row(page, 'beta').locator('[data-counts]')).toHaveText('1 command')
  await expect(row(page, 'beta').locator('[data-badge]')).toHaveText(['Update available: 1.0.1'])
  await expect(row(page, 'gamma').locator('[data-badge]')).toHaveCount(0)
})

test('2.6: installing a plugin by name shows progress, lists it, and its commands join the / list', async () => {
  const { page } = rig
  await openPlugins(page)
  await page.getByLabel('Plugin name').fill('delta')
  await page.getByLabel('Marketplace (optional)').fill('fake-market')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.locator('[data-install-status]')).toContainText('Installing delta')
  await expect(row(page, 'delta')).toBeVisible()
  await expect(row(page, 'delta').locator('[data-counts]')).toHaveText('1 command')
  await expect(page.locator('[data-install-status]')).toHaveText('')

  await backToSession(page)
  await composer(page).fill('/delta')
  await expect(commandOption(page, 'delta:hello')).toBeVisible()
  await expect(commandOption(page, 'delta:hello')).toContainText('Says hello from delta')
  await composer(page).fill('')
})

test('2.6: Update on a plugin with "Update available" shows the new version when it finishes', async () => {
  const { page } = rig
  await openPlugins(page)
  const beta = row(page, 'beta')
  await expect(beta).toContainText('1.0.0')
  await beta.getByRole('button', { name: 'Update beta' }).click()
  await expect(beta).toHaveAttribute('aria-busy', 'true')
  await expect(beta).toContainText('1.0.1', { timeout: 20_000 })
  await expect(beta.locator('[data-badge]')).toHaveCount(0)
  await expect(beta.getByRole('button', { name: 'Update beta' })).toHaveCount(0)
})

test('2.6: Remove asks first; Cancel keeps the plugin, confirming drops it and its commands from the / list', async () => {
  const { page } = rig
  await backToSessionIfSettings(page)
  await composer(page).fill('/gamma')
  await expect(commandOption(page, 'gamma:g1')).toBeVisible()
  await composer(page).fill('')

  await openPlugins(page)
  await row(page, 'gamma').getByRole('button', { name: 'Remove gamma' }).click()
  const dialog = page.getByRole('dialog', { name: 'Remove plugin' })
  await expect(dialog).toContainText(
    'Remove gamma? Its commands stop working in Arc and in Claude Code.'
  )
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row(page, 'gamma')).toBeVisible()

  await row(page, 'gamma').getByRole('button', { name: 'Remove gamma' }).click()
  await page
    .getByRole('dialog', { name: 'Remove plugin' })
    .getByRole('button', { name: 'Remove' })
    .click()
  await expect(row(page, 'gamma')).toHaveCount(0, { timeout: 20_000 })

  await backToSession(page)
  await composer(page).fill('/gamma')
  await expect(commandMenu(page)).toContainText('No matching commands')
  await expect(commandOption(page, 'gamma:g1')).toHaveCount(0)
  await composer(page).fill('')
})

async function backToSessionIfSettings(page: Page): Promise<void> {
  if (await page.locator('[data-settings]').isVisible()) await backToSession(page)
}

test.describe('a failing install', () => {
  let failing: Rig
  let failingHome: FakeHome
  test.beforeAll(async () => {
    failingHome = await makeFakeHome({ plugins: [{ name: 'alpha', commands: { a1: 'First' } }] })
    failing = await launchRig({
      scenario: 'cmd-menu',
      repos: [{ name: 'api' }],
      env: {
        ...failingHome.env,
        FAKE_CLAUDE_PLUGIN_FAIL: 'Plugin "nope" was not found in any marketplace'
      }
    })
  })
  test.afterAll(async () => {
    await failing?.dispose()
    await failingHome?.dispose()
  })

  test('2.6: shows the message Claude Code gave and leaves the list unchanged', async () => {
    const { page } = failing
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.locator('[data-settings] nav').getByRole('button', { name: 'Plugins' }).click()
    await expect(page.getByRole('list', { name: 'Installed plugins' })).toBeVisible()
    await expect(page.locator('[data-plugin]')).toHaveCount(1)

    await page.getByLabel('Plugin name').fill('nope')
    await page.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(page.locator('[data-plugin-failure]')).toHaveText(
      'Plugin "nope" was not found in any marketplace'
    )
    await expect(page.locator('[data-plugin]')).toHaveCount(1)
    await expect(row(page, 'alpha')).toBeVisible()
    await expect(row(page, 'nope')).toHaveCount(0)
  })
})
