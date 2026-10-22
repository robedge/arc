// @spec: 005-commands-and-skills-in-sessions
// @regression
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
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
import { flag, makeFakeHome, saveRepoCommand, sendMessage, sessionStarts } from './commands-rig'
import type { FakeHome } from './commands-rig'

// One Arc run per test, so no test depends on another.
test.setTimeout(120_000)

let rig: Rig | undefined
let home: FakeHome | undefined
test.afterEach(async () => {
  await rig?.dispose()
  await home?.dispose()
  rig = undefined
  home = undefined
})

const badge = (page: Page) => page.getByRole('button', { name: /Needs attention, \d+ waiting/ })
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

async function setup(
  scenario: string,
  homeOptions: Parameters<typeof makeFakeHome>[0] = {},
  env: Record<string, string> = {},
  prepareRepo?: (apiPath: string) => void
): Promise<Rig> {
  home = await makeFakeHome(homeOptions)
  const r = await launchRig({
    scenario,
    repos: [{ name: 'api' }],
    env: { ...home.env, ...env }
  })
  rig = r
  const api = r.repos['api']!
  saveRepoCommand(api, 'awos/spec', 'Creates the Functional Spec')
  prepareRepo?.(api)
  await createGroupWithProjects(r, 'Storefront', [api])
  await startSession(r.page, { request: 'Plan retry settings', mode: 'Autonomous' })
  await expect(r.page.locator('[data-session-screen]')).toBeVisible()
  await expect(r.page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(r.page, '/awos:spec review')
  return r
}

test('2.4: a command question reaches Needs attention with both choices and an Other box; the answer continues the command', async () => {
  const r = await setup('cmd-question')
  const { page } = r
  const card = workerCard(page, 'W1 · /awos:spec')
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')
  await expect(badge(page)).toHaveCount(1)

  // Auto-approve never answers a command's question.
  await page.getByRole('button', { name: 'Approvals' }).click()
  await page.getByRole('dialog', { name: 'Approvals' }).getByLabel('Auto-approve').check()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-auto-approve-on]')).toBeVisible()
  await expect(card).toHaveAttribute('data-worker-card', 'has_question')

  await badge(page).click()
  const dialog = attentionDialog(page)
  const question = dialog.getByRole('article', { name: /Question from W1 · \/awos:spec/ })
  await expect(question).toBeVisible()
  await expect(question.getByText('Where should the review open?')).toBeVisible()
  await expect(question.getByRole('button', { name: /^Browser/ })).toBeVisible()
  await expect(question.getByRole('button', { name: /^Terminal/ })).toBeVisible()
  await expect(question.getByLabel('Other')).toBeVisible()

  // The brain was told it cannot answer; its scripted reply appears only after that note.
  await expect(page.getByText('The question is for you to answer.')).toBeVisible()
  await question.getByRole('button', { name: /^Browser/ }).click()
  await question.getByRole('button', { name: 'Submit' }).click()
  await expect(badge(page)).toHaveCount(0)

  // The command continues with that answer: its next output names the choice.
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 60_000 })
  await card.getByRole('button').first().click()
  await expect(page.getByRole('log', { name: 'W1 · /awos:spec output' })).toContainText(
    'AskUserQuestion answers: {"Where should the review open?":"Browser"}'
  )
  const permission = readFakeLog(r).find((rec) => 'permission' in rec)?.['permission'] as
    { tool_name: string; behavior: string } | undefined
  expect(permission).toMatchObject({ tool_name: 'AskUserQuestion', behavior: 'allow' })
})

test('2.5: a command that pushes a branch asks the user to approve the exact push command', async () => {
  const r = await setup('cmd-safe')
  const { page } = r
  const card = workerCard(page, 'W1 · /awos:spec')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.locator('[data-action]')).toHaveText('git push origin arc/retry-settings')
  await expect(dialog.getByRole('article', { name: /W1 · \/awos:spec/ })).toBeVisible()
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 60_000 })
})

/** Every file and folder name directly inside a plugin folder of the view. */
function viewContents(view: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const plugin of readdirSync(view)) {
    if (plugin.startsWith('.')) continue
    out[plugin] = readdirSync(join(view, plugin)).sort()
  }
  return out
}

test('2.6: personal and plugin hooks and MCP servers load in Arc agents, their permission rules and env do not', async () => {
  const r = await setup(
    'cmd-safe',
    {
      userHook: true,
      userMcp: true,
      plugins: [{ name: 'warp', hooks: true, mcp: true, commands: { go: 'Go' } }]
    },
    { FAKE_CLAUDE_RUN_HOOKS: '1' },
    (api) => {
      // The repository's own committed hook and server.
      saveRepoCommand(api, 'noop', 'No-op', {
        '.claude/settings.json': JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: '*',
                hooks: [{ type: 'command', command: `touch '${home!.markers.repo}'` }]
              }
            ]
          }
        }),
        '.mcp.json': JSON.stringify({
          mcpServers: { tracker: { url: 'https://tracker.test/mcp' } }
        })
      })
    }
  )
  const { page } = r
  const card = workerCard(page, 'W1 · /awos:spec')
  // The command edits a file and then waits at the push approval.
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  const h = home!

  // The fake plays the hooks the CLI would load for the flags Arc passed: the repository hook, the
  // personal hook (through the generated --settings file) and the plugin's hook all ran.
  await expect.poll(() => existsSync(h.markers.repo)).toBe(true)
  await expect.poll(() => existsSync(h.markers.user)).toBe(true)
  await expect.poll(() => existsSync(h.markers.plugin)).toBe(true)

  // Every agent launch still loads project settings only, plus the generated hooks and MCP files.
  const log = readFakeLog(r)
  const starts = sessionStarts(log)
  expect(starts.length).toBeGreaterThanOrEqual(2)
  expect(log.some((rec) => 'argvViolation' in rec)).toBe(false)
  for (const argv of starts) {
    expect(flag(argv, '--setting-sources')).toBe('project')
    expect(argv).toContain('--strict-mcp-config')
    expect(flag(argv, '--plugin-dir')).toContain(join(r.userDataDir, 'agent-plugins'))

    const settingsPath = flag(argv, '--settings')!
    expect(settingsPath).toContain(join(r.userDataDir, 'agent-config'))
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(settings)).toEqual(['hooks'])
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('git push')
    expect(readFileSync(settingsPath, 'utf8')).not.toContain('user-env-secret')

    const mcpPath = argv.find((a) => a.startsWith('--mcp-config='))!.slice('--mcp-config='.length)
    expect(mcpPath).toContain(join(r.userDataDir, 'agent-config'))
    expect(statSync(mcpPath).mode & 0o777).toBe(0o600)
    const servers = (JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers: object }).mcpServers
    expect(Object.keys(servers).sort()).toEqual(['arc', 'figma', 'plugin_warp_spy', 'tracker'])
  }
  const arcEnv = log.filter((rec) => 'arcEnv' in rec).map((rec) => rec['arcEnv'])
  expect(arcEnv).toContainEqual({ ARC_AGENT: '1', ARC_AGENT_ROLE: 'brain', ARC_PROVIDER: 'claude' })
  expect(arcEnv).toContainEqual({
    ARC_AGENT: '1',
    ARC_AGENT_ROLE: 'worker',
    ARC_PROVIDER: 'claude'
  })

  // The plugin view keeps the plugin's hooks and MCP definitions, but no LSP servers or settings.
  const view = flag(starts[0]!, '--plugin-dir')!
  const contents = viewContents(view)
  expect(Object.keys(contents).sort()).toEqual(['user', 'warp'])
  expect(contents['warp']).toEqual(expect.arrayContaining(['hooks', '.mcp.json', 'commands']))
  for (const names of Object.values(contents)) {
    expect(names).not.toContain('.lsp.json')
    expect(names).not.toContain('settings.json')
  }
  const manifest = JSON.parse(
    readFileSync(join(view, 'warp', '.claude-plugin', 'plugin.json'), 'utf8')
  ) as Record<string, unknown>
  expect(manifest).toHaveProperty('hooks')
  expect(manifest).toHaveProperty('mcpServers')
  expect(manifest).not.toHaveProperty('lspServers')
  expect(statSync(join(view, 'warp', 'commands')).isDirectory()).toBe(true)

  await badge(page).click()
  await attentionDialog(page).getByRole('button', { name: 'Deny' }).click()
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 60_000 })
})
