// @spec: 010-cursor-as-a-third-provider
// @regression
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeSettings, openSettings, setDefault } from './codex-rig'
import {
  cursorAgents,
  cursorMcpResults,
  cursorReceived,
  cursorSessions,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { flag, sessionStarts } from './commands-rig'
import {
  createGroupWithProjects,
  eventLog,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'

/**
 * Spec 010 section 2.2 (Slice 4): the brain runs on Cursor, and Auto can pick Cursor. The fake Cursor in `acp` mode
 * plays the Cursor brain and worker, the fake Claude CLI the Claude brain; no model call is made.
 *
 * As in spec 007, a scripted brain cannot choose a provider "when it suits the task". The Auto case checks the
 * plumbing: a brain on Auto that names `provider: "cursor"` gets a Cursor worker, shown on its card.
 */

/** Arc's model probe opens its Cursor session in `userData/cursor-probe`. */
const isProbe = (cwd: string | undefined): boolean => cwd?.endsWith('/cursor-probe') ?? false

let rig: CursorRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

test('2.2: a session brain on Cursor Auto answers in the chat, runs in ask mode in its own folder, and starts a worker that finishes', async () => {
  const r = await launchCursorRig({ cursorScenario: 'cr-brain', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])

  // Settings > Providers > Default brain: Cursor's Auto model.
  await setDefault(page, 'Default brain', 'Auto (default)')
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })

  // The header shows the brain on Cursor and its model.
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Brain · Cursor Auto/)
  // The Cursor brain's answer is in the chat.
  await expect(page.getByText(/Hello from the Cursor brain/)).toBeVisible({ timeout: 20_000 })

  // Its spawn_worker call through Arc's bridge started a Cursor worker, which finishes (merged on Autonomous).
  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expect(eventLog(page).filter({ hasText: /started W1 review · Cursor/ })).toHaveCount(1)
  const spawn = cursorMcpResults(r).filter((m) => m.tool === 'spawn_worker')
  expect(spawn).toHaveLength(1)
  expect(spawn[0]!.isError).toBe(false)

  // No Claude brain ran.
  const claudeBrains = sessionStarts(readFakeLog(r)).filter((argv) =>
    (flag(argv, '--append-system-prompt') ?? '').includes('arc-role:brain')
  )
  expect(claudeBrains).toEqual([])

  // The brain's Cursor session: in Arc's brain folder (not a project checkout), in mode ask.
  expect(cursorAgents(r)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'brain', resumed: false }),
      expect.objectContaining({ role: 'worker', slug: 'review', resumed: false })
    ])
  )
  const brainFolder = join(r.userDataDir, 'codex-brain')
  const sessions = cursorSessions(r).filter((s) => s.method === 'session/new' && !isProbe(s.cwd))
  const brain = sessions.filter((s) => s.cwd?.startsWith(`${brainFolder}/`) === true)
  expect(brain).toHaveLength(1)
  expect(brain[0]!.cwd).not.toBe(repos['api'])
  expect(brain[0]!.cwd!.startsWith(r.root + '/projects')).toBe(false)
  expect(brain[0]!.mcpServers.some((s) => s.name === 'arc')).toBe(true)
  const modes = cursorReceived(r, 'session/set_mode').map(
    (m) => m['params'] as { sessionId?: string; modeId?: string }
  )
  const brainModes = modes.filter((m) => m.sessionId === brain[0]!.sessionId)
  expect(brainModes.map((m) => m.modeId)).toEqual(['ask'])
  // The worker's own session is elsewhere and is not in ask mode.
  const worker = sessions.find((s) => s !== brain[0])
  expect(worker).toBeDefined()
  expect(modes.filter((m) => m.sessionId === worker!.sessionId).map((m) => m.modeId)).not.toContain(
    'ask'
  )
})

test('2.2: with Workers on Auto, a Claude brain that starts a worker on Cursor gets a card showing Cursor and its model', async () => {
  const r = await launchCursorRig({ cursorScenario: 'cr-auto-pick', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Review the work on Cursor', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Auto/i)
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/^Brain · (?!Cursor)/)

  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toHaveText('Cursor · Auto')
  await expect(eventLog(page).filter({ hasText: 'started W1 review · Cursor · Auto' })).toHaveCount(
    1
  )
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  expect(cursorAgents(r)).toEqual([
    expect.objectContaining({ role: 'worker', slug: 'review', resumed: false })
  ])
})

test('2.2: a model Cursor adds is offered in the workers chooser the next time Arc opens', async () => {
  scratch = mkdtempSync(join(tmpdir(), 'arc-cursor-models-'))
  const before = join(scratch, 'models-before.json')
  const after = join(scratch, 'models-after.json')
  const OLD = [
    { modelId: 'default[]', name: 'Auto' },
    { modelId: 'composer-2.5[fast=true]', name: 'composer-2.5' }
  ]
  writeFileSync(before, JSON.stringify(OLD))
  writeFileSync(
    after,
    JSON.stringify([...OLD, { modelId: 'new-model-1[fast=true]', name: 'New Model 1' }])
  )

  const r = await launchCursorRig({
    cursorScenario: 'cr-auto-pick',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_MODELS: before }
  })
  rig = r
  const workers = (p: typeof r.page) => p.getByLabel('Default workers')
  await openSettings(r.page)
  await expect(workers(r.page).locator('option', { hasText: 'composer-2.5' })).toHaveCount(1)
  await expect(workers(r.page).locator('option', { hasText: 'New Model 1' })).toHaveCount(0)
  await closeSettings(r.page)

  // Cursor's account now offers another model; Arc is closed and opened again on the same data.
  r.setCursor({ FAKE_CURSOR_MODELS: after })
  await r.relaunch()
  const again = r.page
  await openSettings(again)
  await expect(workers(again).locator('option', { hasText: 'New Model 1' })).toHaveCount(1, {
    timeout: 20_000
  })
  await expect(workers(again).locator('option', { hasText: 'composer-2.5' })).toHaveCount(1)
  await closeSettings(again)
})
