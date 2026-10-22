// @spec: 005-commands-and-skills-in-sessions
// @regression
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, launchRig, readFakeLog, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'
import { commandMenu, commandOption, composer, makeFakeHome, saveRepoCommand } from './commands-rig'
import type { FakeHome } from './commands-rig'

// One Arc run for the file; every test starts by emptying the message box, so none depends on another.
test.setTimeout(90_000)

let rig: Rig
let home: FakeHome
test.beforeAll(async () => {
  home = await makeFakeHome({
    plugins: [
      {
        name: 'superpowers',
        commands: { brainstorm: 'Explore an idea before building it' },
        skills: ['planning']
      }
    ],
    userCommands: { mine: 'My own helper' }
  })
  rig = await launchRig({
    scenario: 'cmd-menu',
    repos: [{ name: 'api' }, { name: 'web' }],
    env: home.env
  })
  const api = rig.repos['api']!
  saveRepoCommand(api, 'awos/spec', 'Creates the Functional Spec')
  saveRepoCommand(api, 'release-notes', 'Writes the release notes')
  await createGroupWithProjects(rig, 'Storefront', [api, rig.repos['web']!])
  await startSession(rig.page, { request: 'Plan retry settings', mode: 'Autonomous' })
  await expect(rig.page.locator('[data-session-screen]')).toBeVisible()
  await expect(rig.page.getByText('Ready.').first()).toBeVisible()
})
test.afterAll(async () => {
  await rig?.dispose()
  await home?.dispose()
})

test.beforeEach(async () => {
  await composer(rig.page).fill('')
})

test('2.1: typing /aw lists /awos:spec with its description and the repository it is saved in', async () => {
  const { page } = rig
  await composer(page).fill('/aw')
  const option = commandOption(page, 'awos:spec')
  await expect(option).toBeVisible()
  await expect(option).toContainText('Creates the Functional Spec')
  await expect(option).not.toContainText('(project)')
  await expect(option.locator('[data-badge]')).toHaveText(['api'])
  // Built-in commands are not offered, and a non-matching command is filtered out.
  await expect(commandOption(page, 'compact')).toHaveCount(0)
  await expect(commandOption(page, 'release-notes')).toHaveCount(0)
})

test('2.1: the repository saved command /release-notes is listed with api as its source', async () => {
  const { page } = rig
  await composer(page).fill('/rel')
  const option = commandOption(page, 'release-notes')
  await expect(option).toBeVisible()
  await expect(option.locator('[data-badge]')).toHaveText(['api'])
  await expect(option).toContainText('Writes the release notes')
})

test('2.1: installed plugin commands and personal commands are listed as Yours', async () => {
  const { page } = rig
  await composer(page).fill('/super')
  const plugin = commandOption(page, 'superpowers:brainstorm')
  await expect(plugin).toBeVisible()
  await expect(plugin.locator('[data-badge]')).toHaveText(['Yours', 'superpowers'])
  await composer(page).fill('/user:')
  const mine = commandOption(page, 'user:mine')
  await expect(mine).toBeVisible()
  await expect(mine.locator('[data-badge]')).toHaveText(['Yours'])
})

test('2.1: Escape closes the list and the typed text stays in the box', async () => {
  const { page } = rig
  await composer(page).fill('/aw')
  await expect(commandMenu(page)).toBeVisible()
  await composer(page).press('Escape')
  await expect(commandMenu(page)).toHaveCount(0)
  await expect(composer(page)).toHaveValue('/aw')
})

test('2.1: Enter on the highlighted /awos:spec fills the box with "/awos:spec " and sends nothing', async () => {
  const { page } = rig
  const stdinBefore = readFakeLog(rig).filter((r) => 'stdin' in r).length
  await composer(page).fill('/aw')
  await expect(commandOption(page, 'awos:spec')).toHaveAttribute('aria-selected', 'true')
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue('/awos:spec ')
  await expect(commandMenu(page)).toHaveCount(0)
  expect(readFakeLog(rig).filter((r) => 'stdin' in r).length).toBe(stdinBefore)
})

test('2.1: a command that does not exist goes to the brain as ordinary text', async () => {
  const { page } = rig
  await composer(page).fill('/does-not-exist')
  await expect(commandMenu(page)).toContainText('Sent to the brain as a message')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(composer(page)).toHaveValue('')
  await expect(page.getByText('I do not know the command /does-not-exist.')).toBeVisible()
  // The brain got the text as it was typed: no instruction to start a command worker, and no worker.
  const sent = readFakeLog(rig)
    .map((r) => JSON.stringify(r['stdin'] ?? ''))
    .filter((t) => t.includes('/does-not-exist'))
  expect(sent.length).toBeGreaterThan(0)
  expect(sent.join('')).not.toContain('The user ran the command')
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
})
