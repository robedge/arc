// @spec: 007-codex-as-a-second-provider
// @regression
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { FAKE_MCP, NEEDS_ATTENTION, launchCodexRig, readCodexLog } from './codex-rig'
import type { CodexRig } from './codex-rig'
import {
  createGroupWithProjects,
  eventLog,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'

/**
 * Spec 007 section 2.6: the user's own MCP servers and hooks load in Claude and Codex agents, their permission rules
 * do not, and Arc's approvals decide. A temporary HOME holds the "user's" configuration; the real one is never read.
 *
 * The fake agents cannot make a model decide to call Figma. They call the tool the script names, so these tests check
 * what Arc controls: which servers are handed to the agent, which flags keep the user's permission rules out, and
 * whether a read-only call runs unasked and a changing call waits for the user.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const badge = (page: Page) => page.getByRole('button', { name: NEEDS_ATTENTION })
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

const FIGMA_CLAUDE_JSON = JSON.stringify({
  mcpServers: { figma: { command: process.execPath, args: [FAKE_MCP] } }
})

test('2.6: a Claude worker uses the user’s Figma server; reading runs unasked, changing asks with server, tool and details', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-mcp',
    repos: [{ name: 'api' }],
    homeFiles: () => ({ '.claude.json': FIGMA_CLAUDE_JSON })
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · figma-sync')
  // The server reached the worker: the CLI found `figma` in the config it was given.
  await expect
    .poll(() =>
      readFakeLog(r).some((l) => {
        const p = l['personalMcp'] as
          { server?: string; tool?: string; configured?: boolean } | undefined
        return p?.server === 'figma' && p.tool === 'figma_read' && p.configured === true
      })
    )
    .toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')

  // The changing tool asks (the brain passed it on): one request, naming the server, the tool and the details.
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog).toContainText('figma')
  await expect(dialog).toContainText('figma_write')
  await expect(dialog).toContainText('file-1')
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  // Nothing has been allowed yet: the only permission answered so far is the read.
  const decided = (): string[] =>
    readFakeLog(r).flatMap((l) => {
      const p = l['permission'] as { tool_name?: string; behavior?: string } | undefined
      return p?.tool_name?.startsWith('mcp__figma__') ? [`${p.tool_name}:${p.behavior}`] : []
    })
  expect(decided()).toEqual(['mcp__figma__figma_read:allow'])

  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect
    .poll(decided)
    .toEqual(['mcp__figma__figma_read:allow', 'mcp__figma__figma_write:allow'])
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })

  // The read-only call ran without a question, and its result is in the worker's terminal.
  await card.getByRole('button').first().click()
  const terminal = page.getByRole('log', { name: 'W1 · figma-sync output' })
  await expect(terminal).toContainText('mcp__figma__figma_read')
  await expect(terminal).toContainText('(fake) ran: {"id":"file-1"}')
})

test('2.6: the user’s own “always allow git push” is not loaded, so a Claude worker’s push still asks', async () => {
  const r = await launchCodexRig({
    scenario: 'attention-push',
    repos: [{ name: 'api' }],
    homeFiles: () => ({
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Bash(git push:*)'], deny: ['Read(.env)'] },
        hooks: {
          PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'true' }] }]
        }
      })
    })
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Fix order sync', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await badge(page).click()
  await expect(attentionDialog(page).locator('[data-action]')).toHaveText(
    'git push origin arc/fix-order-sync'
  )
  // The agent was started so the user's settings file (and its permission lists) cannot be read: project
  // settings only, with the user's hooks handed over separately.
  const launches = readFakeLog(r)
    .map((l) => l['argv'])
    .filter(
      (a): a is string[] => Array.isArray(a) && a.some((x) => String(x).includes('arc-role:worker'))
    )
  expect(launches.length).toBeGreaterThan(0)
  for (const argv of launches) {
    expect(argv[argv.indexOf('--setting-sources') + 1]).toBe('project')
    const settings = argv[argv.indexOf('--settings') + 1]!
    // `--settings` names a JSON file; it holds the user's hooks and nothing else (no permissions, no env).
    expect(Object.keys(JSON.parse(readFileSync(settings, 'utf8')) as object)).toEqual(['hooks'])
  }
  expect(readFakeLog(r).filter((l) => 'argvViolation' in l)).toEqual([])
  await attentionDialog(page).getByRole('button', { name: 'Deny', exact: true }).click()
  await expect(badge(page)).toHaveCount(0)
})

test('2.6: a Codex worker’s read-only tool of the user’s server runs without a question; a changing one asks and waits', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-mcp-codex',
    codexScenario: 'cx-mcp',
    repos: [{ name: 'api' }],
    codex: {
      FAKE_CODEX_MCP_SERVERS: JSON.stringify({
        figma: { command: 'figma-mcp', args: ['--stdio'] }
      }),
      FAKE_CODEX_MCP_TOOLS: JSON.stringify({
        figma: { figma_read: { readOnlyHint: true }, figma_write: {} }
      })
    }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Update Figma', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · figma-sync')
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  // The read passed without anything in Needs attention: the worker went on to its progress report and then asked
  // about the write, so the only request is the write.
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval')
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog).toContainText('figma')
  await expect(dialog).toContainText('figma_write')
  await expect(dialog).not.toContainText('figma_read')
  await expect(dialog.getByRole('button', { name: 'Approve', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Deny', exact: true })).toBeVisible()
  // The tool has not run.
  await page.waitForTimeout(1000)
  const ran = (): number =>
    readCodexLog(r).filter((l) =>
      (l['shell'] as { cmd?: string } | undefined)?.cmd?.includes('figma-wrote')
    ).length
  expect(ran()).toBe(0)

  await dialog.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(ran).toBe(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expect(eventLog(page).filter({ hasText: /figma/ }).first()).toBeVisible()
})
