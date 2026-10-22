// @spec: 009-choosing-what-agents-load
// @regression
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { launchCodexRig, readCodexLog } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { openUsagePage, openUsagePanel, query } from './usage-rig'
import {
  commandMenu,
  commandOption,
  composer,
  makeFakeHome,
  saveRepoCommand,
  sendMessage
} from './commands-rig'
import type { FakeHome } from './commands-rig'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'

/**
 * Spec 009: the Agent loading page against a temporary HOME (the real ~/.claude and ~/.claude.json are never read)
 * and the fake Claude CLI, which logs what each agent was started with.
 */
test.setTimeout(120_000)

let rig: Rig | undefined
let home: FakeHome | undefined
test.afterEach(async () => {
  await rig?.dispose()
  await home?.dispose()
  rig = undefined
  home = undefined
})

function skill(homeDir: string, name: string, description: string): void {
  const dir = join(homeDir, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`
  )
}

/** A HOME with a plugin, two skills, two user hooks and two user MCP servers. */
async function setup(scenario = 'cmd-menu'): Promise<{ rig: Rig; home: FakeHome }> {
  const h = await makeFakeHome({
    plugins: [{ name: 'alpha', commands: { a1: 'First alpha command' }, skills: ['planning'] }],
    userHook: true,
    userMcp: true
  })
  home = h
  skill(h.home, 'review-helper', 'Helps with reviews')
  skill(h.home, 'deploy-helper', 'Helps with deploys')
  writeFileSync(
    join(h.home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        figma: { command: 'figma-mcp', args: ['--stdio'] },
        trello: { command: 'trello-mcp', args: ['--stdio'] }
      }
    })
  )
  const hook = [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }]
  writeFileSync(
    join(h.home, '.claude', 'settings.json'),
    JSON.stringify({ hooks: { PostToolUse: hook, SessionStart: hook }, permissions: { allow: [] } })
  )
  const r = await launchRig({ scenario, repos: [{ name: 'api' }], env: h.env })
  rig = r
  return { rig: r, home: h }
}

async function openAgentLoading(page: Page, expectItems = true): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await expect(page.getByRole('heading', { name: 'Agent loading' })).toBeVisible()
  if (expectItems) await expect(page.locator('[data-load-item]').first()).toBeVisible()
}

/** The stored selection, read through the same IPC the page uses. */
async function storedOff(page: Page): Promise<{ brain: string[]; workers: string[] }> {
  return page.evaluate(async () => {
    const result = await (
      window as unknown as {
        harness: {
          invoke(c: string, r: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }>
        }
      }
    ).harness.invoke('settings:get', {})
    return result.data['agents.loadOff'] as { brain: string[]; workers: string[] }
  })
}

const item = (page: Page, key: string): Locator => page.locator(`[data-load-item="${key}"]`)
const total = (page: Page, role: 'brain' | 'workers'): Locator =>
  page.locator(`[data-load-total="${role}"]`)

test('2.1: the page lists the groups, all on, with sizes and a total per column', async () => {
  const { page } = (await setup()).rig
  await openAgentLoading(page)

  for (const name of ['MCP servers', 'Plugins', 'Skills', 'Hooks']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible()
  }
  await expect(item(page, 'mcp:figma')).toContainText('Your servers')
  await expect(item(page, 'mcp:figma')).toContainText('size unknown')
  await expect(item(page, 'plugin:alpha@fake-market')).toContainText('about')
  await expect(item(page, 'skill:review-helper')).toContainText('tokens per request')
  await expect(item(page, 'hook:PostToolUse')).toContainText("can't be estimated")

  // Everything starts on, in both columns.
  const switches = page.locator('[data-load-item] input[role="switch"]')
  expect(await switches.count()).toBe(2 * (await page.locator('[data-load-item]').count()))
  await expect(page.locator('[data-load-item] input[role="switch"]:not(:checked)')).toHaveCount(0)
  await expect(total(page, 'brain')).toContainText('tokens per request')
  await expect(page.getByText('Changes apply to agents started afterwards')).toBeVisible()
  await expect(page.getByText('removes its commands from Arc')).toBeVisible()
})

test('2.1: a switch lowers its own column total only, and survives a relaunch', async () => {
  const { rig: r } = await setup()
  const { page } = r
  await openAgentLoading(page)
  const brainBefore = await total(page, 'brain').innerText()
  const workersBefore = await total(page, 'workers').innerText()

  await page.getByRole('switch', { name: 'review-helper, Skill, Workers' }).uncheck()
  await expect(total(page, 'workers')).not.toHaveText(workersBefore)
  await expect(total(page, 'brain')).toHaveText(brainBefore)
  await expect(page.getByRole('switch', { name: 'review-helper, Skill, Brain' })).toBeChecked()
  // Only what is off is stored.
  await expect.poll(() => storedOff(page)).toEqual({ brain: [], workers: ['skill:review-helper'] })

  await r.relaunch()
  await openAgentLoading(r.page)
  await expect(
    r.page.getByRole('switch', { name: 'review-helper, Skill, Workers' })
  ).not.toBeChecked()
  await expect(r.page.getByRole('switch', { name: 'review-helper, Skill, Brain' })).toBeChecked()
  await expect(r.page.getByRole('switch', { name: 'deploy-helper, Skill, Workers' })).toBeChecked()

  // Switching it back on removes it again.
  await r.page.getByRole('switch', { name: 'review-helper, Skill, Workers' }).check()
  await expect(total(r.page, 'workers')).toHaveText(workersBefore)
})

// ---- 2.2: what the agents are started with -------------------------------------------------------------------

type Argv = string[]

/** Every start of an agent with this role, in order (the probe has no role marker). */
function starts(r: Rig, role: 'brain' | 'worker'): Argv[] {
  return readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is Argv => Array.isArray(a) && a.some((x) => String(x).includes(`arc-role:${role}`))
    )
}

function flagValue(argv: Argv, name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

/** The servers of the `--mcp-config` file an agent was started with. */
function mcpServersOf(argv: Argv): string[] {
  const arg = argv.find((a) => a.startsWith('--mcp-config='))
  if (!arg) return []
  const file = JSON.parse(readFileSync(arg.slice('--mcp-config='.length), 'utf8')) as {
    mcpServers: Record<string, unknown>
  }
  return Object.keys(file.mcpServers).sort()
}

/** The hook events of the `--settings` file, or null when the agent got none. */
function hookEventsOf(argv: Argv): string[] | null {
  const path = flagValue(argv, '--settings')
  if (!path) return null
  const file = JSON.parse(readFileSync(path, 'utf8')) as { hooks: Record<string, unknown> }
  return Object.keys(file.hooks).sort()
}

async function backToMain(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-settings]')).toHaveCount(0)
}

async function newSession(r: Rig, request: string): Promise<void> {
  await createGroupOnce(r)
  await startSession(r.page, { request, mode: 'Autonomous', limit: 1 })
}

let groupMade = false
async function createGroupOnce(r: Rig): Promise<void> {
  if (groupMade) return
  groupMade = true
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
}

test.beforeEach(() => {
  groupMade = false
})

test('2.2: an MCP server and a hook event that are off for Workers reach the brain but not the worker, and switching them on again brings them back', async () => {
  const { rig: r } = await setup('autonomous')
  const { page } = r
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'figma, MCP server, Workers' }).uncheck()
  await page.getByRole('switch', { name: 'PostToolUse, Hook, Workers' }).uncheck()
  await expect
    .poll(() => storedOff(page))
    .toEqual({ brain: [], workers: ['mcp:figma', 'hook:PostToolUse'] })
  await backToMain(page)

  await newSession(r, 'Run three jobs')
  await expect(workerCard(page, 'job-one')).toBeVisible()
  await expect.poll(() => starts(r, 'worker').length).toBeGreaterThan(0)

  const brain = starts(r, 'brain')[0]!
  const worker = starts(r, 'worker')[0]!
  // The worker has no figma and no PostToolUse hook; the brain, started with the same files before, has both.
  expect(mcpServersOf(worker)).toEqual(['arc', 'trello'])
  expect(hookEventsOf(worker)).toEqual(['SessionStart'])
  expect(mcpServersOf(brain)).toEqual(['arc', 'figma', 'trello'])
  expect(hookEventsOf(brain)).toEqual(['PostToolUse', 'SessionStart'])

  // Switch both back on: the next worker has them again.
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'figma, MCP server, Workers' }).check()
  await page.getByRole('switch', { name: 'PostToolUse, Hook, Workers' }).check()
  await expect.poll(() => storedOff(page)).toEqual({ brain: [], workers: [] })
  await backToMain(page)
  const before = starts(r, 'worker').length
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await startSession(page, { request: 'Run more jobs', mode: 'Autonomous', limit: 1 })
  await expect.poll(() => starts(r, 'worker').length).toBeGreaterThan(before)
  const again = starts(r, 'worker').at(-1)!
  expect(mcpServersOf(again)).toEqual(['arc', 'figma', 'trello'])
  expect(hookEventsOf(again)).toEqual(['PostToolUse', 'SessionStart'])
})

test('2.2: a server that is off for the Brain reaches the worker, and with every hook off the brain gets no hooks file', async () => {
  const { rig: r } = await setup('autonomous')
  const { page } = r
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'trello, MCP server, Brain' }).uncheck()
  await page.getByRole('switch', { name: 'PostToolUse, Hook, Brain' }).uncheck()
  await page.getByRole('switch', { name: 'SessionStart, Hook, Brain' }).uncheck()
  await expect.poll(async () => (await storedOff(page)).brain.length).toBe(3)
  await backToMain(page)

  await newSession(r, 'Run three jobs')
  await expect.poll(() => starts(r, 'worker').length).toBeGreaterThan(0)
  const brain = starts(r, 'brain')[0]!
  const worker = starts(r, 'worker')[0]!
  expect(mcpServersOf(brain)).toEqual(['arc', 'figma'])
  expect(hookEventsOf(brain)).toBeNull()
  expect(brain).not.toContain('--settings')
  expect(mcpServersOf(worker)).toEqual(['arc', 'figma', 'trello'])
  expect(hookEventsOf(worker)).toEqual(['PostToolUse', 'SessionStart'])
})

test('2.5: the bypass warning follows the hooks: PreToolUse listed under Brain only when it is off for Workers', async () => {
  const { rig: r } = await setup()
  const { page } = r
  writeFileSync(
    join(home!.home, '.claude', 'settings.json'),
    JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'guard.sh' }] }]
      }
    })
  )
  await page.reload()
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'PreToolUse, Hook, Workers' }).uncheck()
  await expect.poll(async () => (await storedOff(page)).workers).toEqual(['hook:PreToolUse'])

  await page.locator('[data-settings] nav').getByRole('button', { name: 'Providers' }).click()
  const warning = page.locator('[data-bypass-warning]')
  await expect(warning).toBeVisible()
  await expect(warning.locator('[data-bypass-role="brain"]')).toContainText('PreToolUse')
  await expect(warning.locator('[data-bypass-role="workers"]')).toContainText('None')

  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await page.getByRole('switch', { name: 'PreToolUse, Hook, Brain' }).uncheck()
  await expect.poll(async () => (await storedOff(page)).brain).toEqual(['hook:PreToolUse'])
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Providers' }).click()
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
  await expect(page.locator('[data-bypass-warning]')).toHaveCount(0)
})

// ---- 2.2 and 2.4: plugins, skills and the `/` list -------------------------------------------------------------

/** The plugin folders of the `--plugin-dir` view an agent was started with, without the `user` wrapper. */
function pluginFoldersOf(argv: Argv): string[] {
  const dir = flagValue(argv, '--plugin-dir')
  if (!dir) return []
  return readdirSync(dir)
    .filter((n) => n !== 'user')
    .sort()
}

function userSkillsOf(argv: Argv): string[] {
  const dir = flagValue(argv, '--plugin-dir')
  return dir ? readdirSync(join(dir, 'user', 'skills')).sort() : []
}

test('2.2: a plugin and a skill that are off for Workers are missing from the worker’s plugin folder but not from the brain’s', async () => {
  const { rig: r } = await setup('autonomous')
  const { page } = r
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'alpha, Plugin, Workers' }).uncheck()
  await page.getByRole('switch', { name: 'review-helper, Skill, Workers' }).uncheck()
  await expect
    .poll(() => storedOff(page))
    .toEqual({ brain: [], workers: ['plugin:alpha@fake-market', 'skill:review-helper'] })
  await backToMain(page)

  await newSession(r, 'Run three jobs')
  await expect.poll(() => starts(r, 'worker').length).toBeGreaterThan(0)
  const brain = starts(r, 'brain')[0]!
  const worker = starts(r, 'worker')[0]!
  expect(pluginFoldersOf(brain)).toEqual(['alpha'])
  expect(userSkillsOf(brain)).toEqual(['deploy-helper', 'review-helper'])
  expect(pluginFoldersOf(worker)).toEqual([])
  expect(userSkillsOf(worker)).toEqual(['deploy-helper'])
})

test('2.4: a plugin that is off for Workers leaves the "/" list at once; off for the Brain only, it stays', async () => {
  const { rig: r } = await setup('cmd-menu')
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Plan retry settings', mode: 'Autonomous' })
  await expect(page.locator('[data-session-screen]')).toBeVisible()
  await expect(page.getByText('Ready.').first()).toBeVisible()

  await composer(page).fill('/alpha')
  await expect(commandOption(page, 'alpha:a1')).toBeVisible()

  // Off for the Brain only: the commands run in workers, so the list does not change.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await page.getByRole('switch', { name: 'alpha, Plugin, Brain' }).uncheck()
  await expect.poll(async () => (await storedOff(page)).brain).toEqual(['plugin:alpha@fake-market'])
  await backToMain(page)
  await composer(page).fill('')
  await composer(page).fill('/alpha')
  await expect(commandOption(page, 'alpha:a1')).toBeVisible()

  // Off for Workers: gone, without restarting Arc.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await page.getByRole('switch', { name: 'alpha, Plugin, Workers' }).uncheck()
  await expect
    .poll(async () => (await storedOff(page)).workers)
    .toEqual(['plugin:alpha@fake-market'])
  await backToMain(page)
  await composer(page).fill('')
  await composer(page).fill('/alpha')
  await expect(commandMenu(page)).toBeVisible()
  await expect(commandOption(page, 'alpha:a1')).toHaveCount(0)

  // And back on: listed again.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await page.getByRole('switch', { name: 'alpha, Plugin, Workers' }).check()
  await expect.poll(async () => (await storedOff(page)).workers).toEqual([])
  await backToMain(page)
  await composer(page).fill('')
  await composer(page).fill('/alpha')
  await expect(commandOption(page, 'alpha:a1')).toBeVisible()
})

/** The text of every user message the fake CLI received on stdin, in order. */
function userTexts(r: Rig): string[] {
  const texts: string[] = []
  for (const record of readFakeLog(r)) {
    const stdin = record['stdin'] as { type?: string; message?: { content?: unknown } } | undefined
    if (stdin?.type !== 'user' || !stdin.message) continue
    const content = stdin.message.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content as { type?: string; text?: string }[]) {
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
    }
  }
  return texts
}

test('2.4: the brain starts a plugin command only while the plugin is on for Workers; otherwise the message is an ordinary one', async () => {
  const { rig: r } = await setup('al-cmd')
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Plan retry settings', mode: 'Autonomous' })
  await expect(page.getByText('Ready.').first()).toBeVisible()

  await sendMessage(page, '/alpha:a1 with the first args')
  await expect(page.getByText('Got the first one.')).toBeVisible()
  await expect
    .poll(() => userTexts(r).some((t) => t.includes('The user ran the command /alpha:a1')))
    .toBe(true)

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await page.getByRole('switch', { name: 'alpha, Plugin, Workers' }).uncheck()
  await expect
    .poll(async () => (await storedOff(page)).workers)
    .toEqual(['plugin:alpha@fake-market'])
  await backToMain(page)

  const before = userTexts(r).length
  await sendMessage(page, '/alpha:a1 with the second args')
  await expect(page.getByText('Got the second one.')).toBeVisible()
  await expect.poll(() => userTexts(r).length).toBeGreaterThan(before)
  const later = userTexts(r).slice(before)
  expect(later.some((t) => t.includes('/alpha:a1 with the second args'))).toBe(true)
  expect(later.some((t) => t.includes('The user ran the command'))).toBe(false)
})

test('2.2: a plugin that is off for Workers stays off when a project’s own settings enable it: the worker gets a name-only stand-in', async () => {
  const { rig: r } = await setup('autonomous')
  const { page } = r
  saveRepoCommand(r.repos['api']!, 'noop', 'Does nothing', {
    '.claude/settings.json': JSON.stringify({ enabledPlugins: { 'alpha@fake-market': true } })
  })
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'alpha, Plugin, Workers' }).uncheck()
  await expect
    .poll(async () => (await storedOff(page)).workers)
    .toEqual(['plugin:alpha@fake-market'])
  await backToMain(page)

  await newSession(r, 'Run three jobs')
  await expect.poll(() => starts(r, 'worker').length).toBeGreaterThan(0)
  const dir = (argv: Argv): string => join(flagValue(argv, '--plugin-dir')!, 'alpha')
  // The worker's copy holds only the manifest: no commands, skills or hooks of the real plugin.
  expect(readdirSync(dir(starts(r, 'worker')[0]!)).sort()).toEqual(['.claude-plugin'])
  expect(readdirSync(dir(starts(r, 'brain')[0]!)).sort()).toContain('commands')
})

// ---- 2.3: Codex servers --------------------------------------------------------------------------------------

let codexRig: CodexRig | undefined
test.afterEach(async () => {
  await codexRig?.dispose()
  codexRig = undefined
})

const CODEX_SERVERS = {
  FAKE_CODEX_MCP_SERVERS: JSON.stringify({
    figma: { command: 'figma-mcp', args: ['--stdio'] },
    github: { command: 'github-mcp' }
  }),
  FAKE_CODEX_MCP_TOOLS: JSON.stringify({
    figma: { figma_read: { readOnlyHint: true } },
    github: { gh_read: { readOnlyHint: true } }
  })
}

async function launchCodex(): Promise<CodexRig> {
  const r = await launchCodexRig({
    scenario: 'cx-mcp-codex',
    codexScenario: 'cx-mcp',
    repos: [{ name: 'api' }],
    codex: CODEX_SERVERS
  })
  codexRig = r
  return r
}

/** The `mcp_servers` of the config a Codex thread was started with. */
function threadServers(r: CodexRig, role: 'worker' | 'brain'): Record<string, unknown> | null {
  for (const l of readCodexLog(r)) {
    const recv = l['recv'] as
      | { method?: string; params?: { config?: { mcp_servers?: Record<string, unknown> } } }
      | undefined
    if (recv?.method !== 'thread/start') continue
    const started = readCodexLog(r)
      .map((x) => x['thread'] as { role?: string } | undefined)
      .filter((t) => t?.role === role)
    if (started.length === 0) continue
    return recv.params?.config?.mcp_servers ?? null
  }
  return null
}

test('2.3: the page lists the Codex servers; one that is off for Workers is disabled on the worker’s thread, the others still ask Arc', async () => {
  const r = await launchCodex()
  const { page } = r
  await openAgentLoading(page)
  await expect(page.getByRole('heading', { name: 'Codex MCP servers' })).toBeVisible()
  await expect(item(page, 'codex-mcp:figma')).toContainText('size unknown')
  await expect(item(page, 'codex-mcp:github')).toBeVisible()

  await page.getByRole('switch', { name: 'figma, Codex MCP server, Workers' }).uncheck()
  await expect.poll(() => storedOff(page)).toEqual({ brain: [], workers: ['codex-mcp:figma'] })
  await backToMain(page)

  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma', mode: 'Autonomous' })
  await expect.poll(() => threadServers(r, 'worker')).not.toBeNull()
  const servers = threadServers(r, 'worker')!
  expect(servers['figma']).toEqual({ enabled: false })
  expect(servers['github']).toEqual({ default_tools_approval_mode: 'prompt' })
  expect(servers['arc']).toMatchObject({ default_tools_approval_mode: 'approve' })
})

test('2.3: a Codex server that is off for the Brain only still runs on the worker’s thread', async () => {
  const r = await launchCodex()
  const { page } = r
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'figma, Codex MCP server, Brain' }).uncheck()
  await expect.poll(() => storedOff(page)).toEqual({ brain: ['codex-mcp:figma'], workers: [] })
  await backToMain(page)

  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma', mode: 'Autonomous' })
  await expect.poll(() => threadServers(r, 'worker')).not.toBeNull()
  const servers = threadServers(r, 'worker')!
  expect(servers['figma']).toEqual({ default_tools_approval_mode: 'prompt' })
  expect(servers['github']).toEqual({ default_tools_approval_mode: 'prompt' })
})

test('2.3: without a signed-in Codex the group says its servers can’t be listed', async () => {
  const r = await launchCodexRig({
    scenario: 'cmd-menu',
    repos: [{ name: 'api' }],
    codexInstalled: false
  })
  codexRig = r
  await openAgentLoading(r.page, false)
  await expect(
    r.page.getByText("Codex isn't set up, so its servers can't be listed.")
  ).toBeVisible()
})

// ---- 2.6: the Setup overhead suggestion and the measured setup ------------------------------------------------

test('2.6: the CLI-heavy Setup overhead suggestion has a button that opens Agent loading, in the usage panel and on the Usage page', async () => {
  const r = await launchCodexRig({
    scenario: 'sg-setup',
    repos: [{ name: 'api' }],
    codexInstalled: false
  })
  codexRig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Say hello', mode: 'Autonomous' })

  const panel = await openUsagePanel(r.page)
  const suggestion = panel.locator('[data-suggestion="setup-overhead"]')
  await expect(suggestion).toHaveCount(1, { timeout: 30_000 })
  await suggestion.getByRole('button', { name: 'Choose what agents load' }).click()
  await expect(r.page.locator('[data-settings]')).toBeVisible()
  await expect(r.page.getByRole('heading', { name: 'Agent loading' })).toBeVisible()
  await expect(
    r.page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' })
  ).toHaveAttribute('aria-current', 'page')

  // The same button on the Usage page's list.
  await r.page.getByRole('button', { name: 'Back' }).click()
  await openUsagePage(r.page)
  await r.page
    .locator('[data-usage-view] [data-suggestion="setup-overhead"]')
    .getByRole('button', { name: 'Choose what agents load' })
    .click()
  await expect(r.page.getByRole('heading', { name: 'Agent loading' })).toBeVisible()
})

test('2.6: a worker started after a server was switched off measures a smaller fixed setup than one started before', async () => {
  const h = await makeFakeHome({ plugins: [{ name: 'alpha', commands: { a1: 'First' } }] })
  home = h
  writeFileSync(
    join(h.home, '.claude.json'),
    JSON.stringify({
      mcpServers: { figma: { command: 'figma-mcp' }, trello: { command: 'trello-mcp' } }
    })
  )
  const r = await launchRig({
    scenario: 'autonomous',
    repos: [{ name: 'api' }],
    env: { ...h.env, FAKE_CLAUDE_SETUP_PER_ITEM: '1000' }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Run three jobs', mode: 'Autonomous', limit: 1 })

  /** The measured fixed setup of each worker, by session. */
  const fixedSetups = (): { session: string; tokens: number }[] =>
    query(
      r,
      "SELECT session_id AS s, fixed_setup_tokens AS t FROM agent_setup WHERE agent_key != 'brain' AND fixed_setup_tokens IS NOT NULL"
    ).map((row) => ({ session: String(row['s']), tokens: Number(row['t']) }))
  await expect.poll(() => fixedSetups().length, { timeout: 30_000 }).toBeGreaterThan(0)
  const firstSession = fixedSetups()[0]!.session
  const before = fixedSetups()[0]!.tokens

  // Switch the two servers and the plugin off for Workers, then start another session.
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  for (const name of [
    'figma, MCP server, Workers',
    'trello, MCP server, Workers',
    'alpha, Plugin, Workers'
  ]) {
    await page.getByRole('switch', { name }).uncheck()
  }
  await expect.poll(async () => (await storedOff(page)).workers.length).toBe(3)
  await backToMain(page)
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  await startSession(page, { request: 'Run more jobs', mode: 'Autonomous', limit: 1 })

  const other = (): { session: string; tokens: number }[] =>
    fixedSetups().filter((f) => f.session !== firstSession)
  await expect.poll(() => other().length, { timeout: 60_000 }).toBeGreaterThan(0)
  // Three loaded items (two servers and a plugin) of 1,000 tokens each are gone from the first request.
  expect(before - other()[0]!.tokens).toBe(3000)
})

// ---- 2.1: defaults, new items, keyboard, copy ------------------------------------------------------------------

test('2.1: nothing is stored until the user switches something off, and switching it back on leaves nothing off', async () => {
  const { rig: r } = await setup()
  const { page } = r
  const stored = (): number =>
    Number(
      query(r, "SELECT count(*) AS c FROM app_settings WHERE key = 'agents.loadOff'")[0]?.['c']
    )
  await openAgentLoading(page)
  expect(stored()).toBe(0)
  expect(await storedOff(page)).toEqual({ brain: [], workers: [] })

  await page.getByRole('switch', { name: 'trello, MCP server, Brain' }).uncheck()
  await expect.poll(stored).toBe(1)
  await page.getByRole('switch', { name: 'trello, MCP server, Brain' }).check()
  await expect.poll(() => storedOff(page)).toEqual({ brain: [], workers: [] })
})

test('2.1: a plugin installed after another item was switched off starts on in both columns, and the other item stays off', async () => {
  const { rig: r } = await setup()
  const { page } = r
  await openAgentLoading(page)
  await page.getByRole('switch', { name: 'review-helper, Skill, Workers' }).uncheck()
  await expect.poll(async () => (await storedOff(page)).workers).toEqual(['skill:review-helper'])

  await page.locator('[data-settings] nav').getByRole('button', { name: 'Plugins' }).click()
  await expect(page.getByRole('list', { name: 'Installed plugins' })).toBeVisible()
  await page.getByLabel('Plugin name').fill('delta')
  await page.getByLabel('Marketplace (optional)').fill('fake-market')
  await page.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.locator('[data-plugin="delta@fake-market"]')).toBeVisible({ timeout: 20_000 })

  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await expect(item(page, 'plugin:delta@fake-market')).toBeVisible()
  await expect(page.getByRole('switch', { name: 'delta, Plugin, Brain' })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'delta, Plugin, Workers' })).toBeChecked()
  await expect(
    page.getByRole('switch', { name: 'review-helper, Skill, Workers' })
  ).not.toBeChecked()
})

test('2.1: the keyboard walks the switches row by row, Brain then Workers, and Space flips the focused one', async () => {
  const { rig: r } = await setup()
  const { page } = r
  await openAgentLoading(page)
  const first = page.getByRole('switch', { name: 'figma, MCP server, Brain' })
  await first.focus()
  await expect(first).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('switch', { name: 'figma, MCP server, Workers' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('switch', { name: 'trello, MCP server, Brain' })).toBeFocused()
  await page.keyboard.press('Space')
  await expect(page.getByRole('switch', { name: 'trello, MCP server, Brain' })).not.toBeChecked()
  await expect.poll(async () => (await storedOff(page)).brain).toEqual(['mcp:trello'])
})

test('2.1: the page says when changes apply, what leaves the "/" list, and what is always loaded', async () => {
  const { rig: r } = await setup()
  const page = r.page
  await openAgentLoading(page)
  const text = page.locator('[data-agent-load]')
  await expect(text).toContainText('Changes apply to agents started afterwards')
  await expect(text).toContainText('a resumed agent picks them up on its next start')
  await expect(text).toContainText('removes its commands from Arc')
  await expect(text).toContainText("Arc's own tools are always loaded")
})
