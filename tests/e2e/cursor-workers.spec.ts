// @spec: 010-cursor-as-a-third-provider
// @regression
import { expect, test } from '@playwright/test'
import { setDefault } from './codex-rig'
import { cursorAgents, cursorReceived, cursorSessions, launchCursorRig } from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, git, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 Slice 2: a worker runs on Cursor and its change can be merged. The brain is the fake Claude CLI and the
 * worker is the fake Cursor in `acp` mode; no model call is made. Slice 9 builds on these cases.
 */

/** Arc's model probe opens its Cursor session in `userData/cursor-probe`. */
const isProbe = (cwd: string | undefined): boolean => cwd?.endsWith('/cursor-probe') ?? false

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

test('a worker set to Cursor Auto runs on Cursor, streams into its terminal and its change is merged', async () => {
  const r = await launchCursorRig({ cursorScenario: 'cr-worker-slow', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])

  // Settings > Providers > Default workers: Cursor's Auto model.
  await setDefault(page, 'Default workers', 'Auto (default)')

  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  const title = 'W1 · review'
  const card = workerCard(page, title)
  await expect(card.locator('[data-worker-model]')).toHaveText('Cursor · Auto')
  await expect(card).toHaveAttribute('data-worker-card', 'working')

  // The terminal is open while the worker is still talking: its first line is there, the later ones arrive.
  await card.getByRole('button').first().click()
  const terminal = page.getByRole('log', { name: `${title} output` })
  await expect(terminal.getByText('Starting.')).toBeVisible()
  await expect(terminal.getByText('Done.')).toHaveCount(0)
  await expect(terminal.getByText('Writing cursor-note.txt now.')).toBeVisible({ timeout: 20_000 })
  await expect(terminal.getByText('Done.')).toBeVisible({ timeout: 20_000 })

  // Merged into the session branch by itself (Autonomous), and the brain was told.
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  await expect(eventLog(page).filter({ hasText: /Merged W1 review into arc\// })).toHaveCount(1)
  const branch = git(repos['api']!, 'branch', '--list', 'arc/*', '--format=%(refname:short)')
    .trim()
    .split('\n')[0]!
  expect(branch).toMatch(/^arc\//)
  expect(git(repos['api']!, 'show', `${branch}:cursor-note.txt`)).toBe(
    'written by the fake Cursor\n'
  )
  expect(git(repos['api']!, 'log', branch, '--format=%s')).toContain('Add cursor note')

  // What Arc told the fake Cursor: Arc's bridge in session/new, and the chosen model.
  expect(cursorAgents(r)).toEqual([
    expect.objectContaining({ role: 'worker', slug: 'review', resumed: false })
  ])
  // Arc's model probe also opens a session (in userData/cursor-probe, with no MCP servers); the worker's is the other one.
  const sessions = cursorSessions(r).filter((s) => s.method === 'session/new' && !isProbe(s.cwd))
  expect(sessions).toHaveLength(1)
  expect(sessions[0]!.cwd).not.toBe(repos['api'])
  const arc = sessions[0]!.mcpServers.find((s) => s.name === 'arc')
  expect(arc).toBeDefined()
  expect(arc!.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
  expect(arc!.headers?.some((h) => h.name.toLowerCase() === 'authorization')).toBe(true)
  const setModel = cursorReceived(r, 'session/set_model').map(
    (m) => (m['params'] as { modelId?: string }).modelId
  )
  expect(setModel).toContain('default[]')
})

test('2.3: the text of a Cursor worker shows in its terminal during a long pause, not when the next item arrives', async () => {
  const r = await launchCursorRig({ cursorScenario: 'cr-stream', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default workers', 'Auto (default)')
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()
  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')

  const title = 'W1 · review'
  const card = workerCard(page, title)
  await expect(card).toHaveAttribute('data-worker-card', 'working')
  await card.getByRole('button').first().click()
  const terminal = page.getByRole('log', { name: `${title} output` })
  // The worker sent two word-sized chunks and is now asleep for 15 s; the words are visible well before it wakes.
  await expect(terminal.getByText('Thinking out loud.')).toBeVisible({ timeout: 8000 })
  await expect(terminal.getByText('Late words.')).toHaveCount(0)
})

test('a Claude-only session with the default workers starts no Cursor agent', async () => {
  const r = await launchCursorRig({ scenario: 'am-clean', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Add retry', mode: 'Autonomous' })

  const card = workerCard(page, 'W1 · api-retry')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Claude · /)
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 30_000 })
  await expect(page.getByText('Summary: api got retry.txt in the commit Add retry.')).toBeVisible()
  expect(git(repos['api']!, 'log', 'arc/retry-work', '--format=%s')).toContain('Add retry')

  // Arc may have probed Cursor (status, about, and the model probe's acp session in userData/cursor-probe), but no
  // Cursor agent ran: no session anywhere else, no prompt, no script chosen.
  for (const s of cursorSessions(r)) {
    expect(isProbe(s.cwd)).toBe(true)
    expect(s.mcpServers).toEqual([])
  }
  expect(cursorReceived(r, 'session/prompt')).toEqual([])
  expect(cursorAgents(r)).toEqual([])
})
