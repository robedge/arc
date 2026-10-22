// @spec: 010-cursor-as-a-third-provider
// @regression
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { NEEDS_ATTENTION, setDefault } from './codex-rig'
import {
  cursorMcpResults,
  cursorPermissionAnswers,
  cursorSessions,
  cursorShellRuns,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig, CursorSessionStart } from './cursor-rig'
import { createGroupWithProjects, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 section 2.7 (Slice 7): the user's Cursor MCP servers, switchable on Agent loading. The temp HOME has a
 * `~/.cursor/mcp.json` with one stdio server, `fakeuser` (tests/unit/helpers/fake-mcp-user-server.mjs: `lookup` is
 * read-only, `remove` destructive). The fake Cursor does not load that file itself, so these cases assert what Arc
 * controls: the session/new `mcpServers` (a same-name `/off/<server>` entry only when the role switched it off), the
 * deny file `.cursor/cli.json` in the worker's working copy (`Mcp(<server>:*)` only when off), and how Arc answers
 * the MCP-shaped permission requests Cursor sends for the server's tools (no annotations in the request, so Arc asks
 * the server's own tools/list). Every case also checks that nothing under the temp HOME's `.cursor` changed.
 */
test.setTimeout(120_000)

const SERVER = 'fakeuser'
const FAKE_USER_SERVER = resolve('tests/unit/helpers/fake-mcp-user-server.mjs')
const W1 = 'W1 · review'

const MCP_JSON = JSON.stringify(
  { mcpServers: { [SERVER]: { command: process.execPath, args: [FAKE_USER_SERVER] } } },
  null,
  2
)
const CLI_CONFIG = JSON.stringify(
  {
    version: 1,
    permissions: { allow: [], deny: [] },
    privacyCache: { ghostMode: false, privacyMode: 1, updatedAt: 1760000000000 }
  },
  null,
  2
)

/** Arc's model probe opens its Cursor session in `userData/cursor-probe`. */
const isProbe = (cwd: string | undefined): boolean => cwd?.endsWith('/cursor-probe') ?? false

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

async function launch(cursorScenario: string): Promise<CursorRig> {
  const r = await launchCursorRig({
    cursorScenario,
    repos: [{ name: 'api' }],
    homeFiles: () => ({ '.cursor/mcp.json': MCP_JSON, '.cursor/cli-config.json': CLI_CONFIG })
  })
  rig = r
  return r
}

// ---- the hash check --------------------------------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** sha256 of the two files' text (`cli-config.json` without `privacyCache.updatedAt`, which Cursor itself bumps). */
function hashes(mcp: string | null, cli: string | null): Record<string, string | null> {
  let cliHash: string | null = null
  if (cli !== null) {
    const parsed = JSON.parse(cli) as { privacyCache?: Record<string, unknown> }
    if (parsed.privacyCache) delete parsed.privacyCache['updatedAt']
    cliHash = sha256(JSON.stringify(parsed))
  }
  return { 'mcp.json': mcp === null ? null : sha256(mcp), 'cli-config.json': cliHash }
}

/** The hashes of the temp HOME's `~/.cursor/mcp.json` and `cli-config.json` as they are now. */
function cursorHashes(home: string): Record<string, string | null> {
  const read = (name: string): string | null => {
    const path = join(home, '.cursor', name)
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return hashes(read('mcp.json'), read('cli-config.json'))
}

/** What the test wrote before Arc started. */
const WRITTEN = hashes(MCP_JSON, CLI_CONFIG)

/** Both files are as written before Arc started, and as they were when the case began. */
function expectCursorFilesUnchanged(r: CursorRig, before: Record<string, string | null>): void {
  expect(before).toEqual(WRITTEN)
  expect(cursorHashes(r.home)).toEqual(WRITTEN)
}

// ---- Agent loading -------------------------------------------------------------------------------------------

async function openAgentLoading(page: Page): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await expect(page.getByRole('heading', { name: 'Agent loading' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Cursor MCP servers' })).toBeVisible()
}

async function backToMain(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-settings]')).toHaveCount(0)
}

const item = (page: Page, key: string): Locator => page.locator(`[data-load-item="${key}"]`)
const badge = (page: Page): Locator => page.getByRole('button', { name: NEEDS_ATTENTION })
const attentionDialog = (page: Page): Locator =>
  page.getByRole('dialog', { name: /Needs attention/ })

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

// ---- the session/new log -------------------------------------------------------------------------------------

/** Agent sessions (not the model probe), split into the brain's (in Arc's brain folder) and the others. */
function agentSessions(r: CursorRig): {
  brain: CursorSessionStart[]
  workers: CursorSessionStart[]
} {
  const brainFolder = join(r.userDataDir, 'codex-brain')
  const all = cursorSessions(r).filter((s) => s.method === 'session/new' && !isProbe(s.cwd))
  const inBrain = (s: CursorSessionStart): boolean => s.cwd?.startsWith(`${brainFolder}/`) === true
  return { brain: all.filter(inBrain), workers: all.filter((s) => !inBrain(s)) }
}

const answersFor = (r: CursorRig, toolCallId: string) =>
  cursorPermissionAnswers(r).filter((a) => a.toolCallId === toolCallId)

const denyCheck = (r: CursorRig) => cursorShellRuns(r).filter((s) => s.cmd.includes('cli.json'))

// ---- the cases -----------------------------------------------------------------------------------------------

test('2.7: Agent loading lists the user’s Cursor server; a Cursor worker has it on, its read-only tool runs unasked and its changing tool waits in Needs attention', async () => {
  const r = await launch('cm-use')
  const { page, repos } = r
  const before = cursorHashes(r.home)

  // The "Cursor MCP servers" group lists the server with its source, on in both columns.
  await openAgentLoading(page)
  const row = item(page, `cursor-mcp:${SERVER}`)
  await expect(row).toContainText(SERVER)
  await expect(row).toContainText('Your Cursor servers')
  await expect(
    page.getByRole('switch', { name: `${SERVER}, Cursor MCP server, Brain` })
  ).toBeChecked()
  await expect(
    page.getByRole('switch', { name: `${SERVER}, Cursor MCP server, Workers` })
  ).toBeChecked()
  await backToMain(page)

  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)

  // On for Workers: the worker's session/new has Arc's bridge and no same-name stand-in for the user's server, so
  // Cursor would load it from ~/.cursor/mcp.json; the deny file in its working copy has no Mcp(fakeuser...) entry.
  await expect.poll(() => agentSessions(r).workers.length).toBe(1)
  const worker = agentSessions(r).workers[0]!
  expect(worker.mcpServers.map((s) => s.name)).toEqual(['arc'])
  expect(worker.mcpServers.some((s) => s.url?.includes('/off/') === true)).toBe(false)
  await expect.poll(() => denyCheck(r)).toEqual([expect.objectContaining({ code: 0 })])

  // `lookup` (read-only by the server's own tools/list) is allowed once without asking anyone.
  await expect
    .poll(() => answersFor(r, 'mcp-lookup'), { timeout: 20_000 })
    .toEqual([{ toolCallId: 'mcp-lookup', outcome: 'selected', optionId: 'allow-once' }])

  // `remove` (destructive) is an approval request: the brain (cm-use) passes it on, so it waits in Needs attention as
  // a request for the user's MCP server, and the fake Cursor gets its answer only on Approve.
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  await expect(badge(page)).toHaveCount(1)
  await badge(page).click()
  const dialog = attentionDialog(page)
  const request = dialog.getByRole('article', { name: /Permission request from W1 review/ })
  await expect(request).toHaveCount(1)
  await expect(request).toContainText('Wants to use a tool from one of your MCP servers')
  await expect(request.locator('dt:has-text("Server") + dd')).toHaveText(SERVER)
  await expect(request.locator('dt:has-text("Tool") + dd')).toHaveText('remove')
  await page.waitForTimeout(1000)
  expect(answersFor(r, 'mcp-remove')).toEqual([])
  await request.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(badge(page)).toHaveCount(0)
  await expect
    .poll(() => answersFor(r, 'mcp-remove'))
    .toEqual([{ toolCallId: 'mcp-remove', outcome: 'selected', optionId: 'allow-once' }])
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })

  expectCursorFilesUnchanged(r, before)
})

test('2.7: a server off for Workers gets an /off/ stand-in and a deny entry on the Cursor worker, and its tool is declined unasked; the Cursor brain still has it', async () => {
  const r = await launch('cm-off')
  const { page, repos } = r
  const before = cursorHashes(r.home)

  await openAgentLoading(page)
  await page.getByRole('switch', { name: `${SERVER}, Cursor MCP server, Workers` }).uncheck()
  await expect.poll(() => storedOff(page)).toEqual({ brain: [], workers: [`cursor-mcp:${SERVER}`] })
  await expect(
    page.getByRole('switch', { name: `${SERVER}, Cursor MCP server, Brain` })
  ).toBeChecked()
  await backToMain(page)

  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Auto (default)')
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Brain · Cursor/)
  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })

  const { brain, workers } = agentSessions(r)
  expect(brain).toHaveLength(1)
  expect(workers).toHaveLength(1)

  // The worker: a same-name entry pointing at the bridge's /off/fakeuser, under the bridge's own token.
  const arc = workers[0]!.mcpServers.find((s) => s.name === 'arc')!
  const off = workers[0]!.mcpServers.find((s) => s.name === SERVER)
  expect(off).toBeDefined()
  const arcUrl = new URL(arc.url!)
  const offUrl = new URL(off!.url!)
  expect(offUrl.origin).toBe(arcUrl.origin)
  expect(offUrl.pathname).toBe(`/off/${SERVER}`)
  expect(off!.headers).toEqual(arc.headers)
  // Its deny file holds Mcp(fakeuser:*) (the grep in the worker's working copy exited 0).
  expect(denyCheck(r)).toEqual([expect.objectContaining({ code: 0 })])
  // A request for the off server's tool is declined (reject-once), and nothing came to Needs attention.
  expect(answersFor(r, 'mcp-remove')).toEqual([
    { toolCallId: 'mcp-remove', outcome: 'selected', optionId: 'reject-once' }
  ])
  await expect(badge(page)).toHaveCount(0)

  // The Cursor brain (on for Brain): Arc's bridge only, no stand-in for fakeuser, so Cursor loads it.
  expect(brain[0]!.mcpServers.map((s) => s.name)).toEqual(['arc'])
  expect(brain[0]!.mcpServers.some((s) => s.url?.includes('/off/') === true)).toBe(false)
  expect(cursorMcpResults(r).filter((m) => m.tool === 'spawn_worker' && !m.isError)).toHaveLength(1)

  expectCursorFilesUnchanged(r, before)
})

test('2.7: without Cursor the group says its servers can’t be listed', async () => {
  const r = await launchCursorRig({
    scenario: 'cmd-menu',
    repos: [{ name: 'api' }],
    cursorInstalled: false,
    homeFiles: () => ({ '.cursor/mcp.json': MCP_JSON, '.cursor/cli-config.json': CLI_CONFIG })
  })
  rig = r
  const before = cursorHashes(r.home)
  await openAgentLoading(r.page)
  await expect(
    r.page.getByText("Cursor isn't set up, so its servers can't be listed.")
  ).toBeVisible()
  await expect(item(r.page, `cursor-mcp:${SERVER}`)).toHaveCount(0)
  expectCursorFilesUnchanged(r, before)
})
