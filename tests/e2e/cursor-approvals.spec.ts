// @spec: 010-cursor-as-a-third-provider
// @regression
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openSettings } from './codex-rig'
import {
  approve,
  deny,
  dock,
  expectNoneWaiting,
  expectWaiting,
  permissionAction,
  request
} from './attention-rig'
import {
  cursorAgents,
  cursorPermissionAnswers,
  cursorPrompts,
  cursorSessions,
  cursorShellRuns,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 section 2.4 (Slice 3): risky Cursor actions come to the user, or are blocked with a note. The brain is
 * the fake Claude CLI and the worker is the fake Cursor in `acp` mode; no model call is made.
 */

let rig: CursorRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  scratch = undefined
})

const W1 = 'W1 · review'
const PUSH = 'git push origin HEAD'

async function setup(cursorScenario: string): Promise<CursorRig> {
  const r = await launchCursorRig({ cursorScenario, repos: [{ name: 'api' }] })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Review the work', mode: 'Autonomous' })
  return r
}

const pushAnswers = (r: CursorRig) =>
  cursorPermissionAnswers(r).filter((a) => a.toolCallId === 'push-1')
const ranPush = (r: CursorRig) => cursorShellRuns(r).some((s) => s.cmd === PUSH)

test('2.4: a Cursor worker asks to push; Needs attention shows the exact command and nothing runs until Approve', async () => {
  const r = await setup('cr-push')
  const { page } = r

  const card = workerCard(page, W1)
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  await expectWaiting(page, 1)
  const panel = request(page, 'permission')
  await expect(permissionAction(panel)).toHaveText(PUSH)

  // Waiting: the fake Cursor has no answer and has not run the push.
  await page.waitForTimeout(1000)
  expect(pushAnswers(r)).toEqual([])
  expect(ranPush(r)).toBe(false)

  await approve(panel)
  await expectNoneWaiting(page)
  // Allowed once (never "allow always"), and only then the push ran.
  await expect
    .poll(() => pushAnswers(r))
    .toEqual([{ toolCallId: 'push-1', outcome: 'selected', optionId: 'allow-once' }])
  await expect.poll(() => ranPush(r)).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: a refused Cursor push answers reject-once and the next prompt starts with the decline', async () => {
  const r = await setup('cr-push-deny')
  const { page } = r

  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  const panel = request(page, 'permission')
  await expect(permissionAction(panel)).toHaveText(PUSH)
  await deny(panel)
  await expectNoneWaiting(page)

  await expect
    .poll(() => pushAnswers(r))
    .toEqual([{ toolCallId: 'push-1', outcome: 'selected', optionId: 'reject-once' }])
  expect(ranPush(r)).toBe(false)

  // The worker ended its turn without report_done; Arc's next prompt to it carries the decline first.
  await expect.poll(() => cursorPrompts(r).filter((p) => p.role === 'worker').length).toBe(2)
  const next = cursorPrompts(r).filter((p) => p.role === 'worker')[1]!
  expect(next.text.startsWith(`[Arc] Your request to run \`${PUSH}\` was declined`)).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test('2.4: an ordinary command in the Cursor worker’s working copy runs without asking', async () => {
  const r = await setup('cr-unasked')
  const { page } = r

  const card = workerCard(page, W1)
  // Arc answered `git status` itself: allow-once, with no Needs attention item at any point.
  await expect
    .poll(async () => {
      expect(await dock(page).count()).toBe(0)
      return cursorPermissionAnswers(r)
    })
    .toEqual([{ toolCallId: 'status-1', outcome: 'selected', optionId: 'allow-once' }])
  await expect.poll(() => cursorShellRuns(r).some((s) => s.cmd === 'git status')).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expectNoneWaiting(page)
})

test('2.4: a push Cursor never asks about is blocked, and the event log shows a Blocked note naming the worker', async () => {
  const r = await setup('cr-blocked')
  const { page } = r

  const card = workerCard(page, W1)
  const note = eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })
  await expect(note).toHaveCount(1, { timeout: 20_000 })
  await expect(note).toHaveAttribute('data-event-kind', 'cursor-blocked')
  await expect(note).toContainText(`W1 couldn't run \`${PUSH}\`: Arc blocked it`)
  const chip = note.getByRole('button', { name: 'Show W1' })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(card.getByRole('button').first()).toBeFocused()

  // Nothing asked and nothing ran.
  expect(cursorPermissionAnswers(r)).toEqual([])
  expect(ranPush(r)).toBe(false)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
})

test("2.4: Settings > Providers warns about the user's Cursor allow rule", async () => {
  const r = await launchCursorRig({
    cursorScenario: 'cr-worker',
    repos: [{ name: 'api' }],
    homeFiles: () => ({
      '.cursor/cli-config.json': JSON.stringify({ permissions: { allow: ['Shell(git push)'] } })
    })
  })
  rig = r
  const { page } = r
  // Main reads the temp HOME's ~/.cursor/cli-config.json.
  const report = (await page.evaluate(() => window.arc.invoke('providers:bypass', {}))) as {
    ok: boolean
    data?: { cursor?: { allowEntries: string[] } }
  }
  expect(report.data?.cursor?.allowEntries).toEqual(['Shell(git push)'])

  await openSettings(page)
  const warning = page.locator('[data-bypass-warning]')
  await expect(warning).toBeVisible()
  const cursor = warning.locator('[data-bypass-cursor]')
  await expect(cursor).toContainText("Cursor settings that can skip Arc's approvals")
  await expect(cursor.locator('[data-bypass-cursor-allow] li')).toHaveText(['Shell(git push)'])
})

// ---- Spec 015 slice 6: Skip all approvals lifts the Cursor deny file, and a push still asks ------------------------

const skipSwitch = (page: Page) => page.getByLabel('Skip all approvals', { exact: true })
const skipDialog = (page: Page) => page.getByRole('dialog', { name: 'Skip all approvals?' })
const skipMarker = (page: Page) => page.locator('[data-skip-approvals-on]')

/** Header Approvals popover, the switch, the warning dialog's confirm. */
async function turnSkipOn(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Approvals' }).click()
  await skipSwitch(page).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await expect(skipMarker(page)).toBeVisible()
  await page.keyboard.press('Escape')
}

/** The New Session dialog with its Skip all approvals switch on (the warning dialog confirmed). */
async function startSkippingSession(page: Page, request: string): Promise<void> {
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog', { name: 'New Session' })
  await dialog.getByLabel('Request').fill(request)
  await dialog.getByLabel('Autonomous', { exact: false }).check()
  await dialog.getByLabel('Skip all approvals', { exact: true }).click()
  await skipDialog(page).getByRole('button', { name: 'Skip all approvals' }).click()
  await expect(skipDialog(page)).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Start' }).click()
}

/** Per-worker scripts for the fake Cursor, written to a scratch folder (the brain comes from `cr-push`). */
function writeScripts(files: Record<string, object[]>): string {
  scratch = mkdtempSync(join(tmpdir(), 'arc-cursor-skip-'))
  const dir = join(scratch, 'scripts')
  mkdirSync(dir)
  for (const [name, steps] of Object.entries(files)) {
    writeFileSync(join(dir, name), steps.map((s) => JSON.stringify(s)).join('\n') + '\n')
  }
  return dir
}

/** The worker's agent sessions (not Arc's model probe, which opens its own in `userData/cursor-probe`). */
const workerStarts = (r: CursorRig, method: string) =>
  cursorSessions(r).filter(
    (s) => s.method === method && !(s.cwd?.endsWith('/cursor-probe') ?? false)
  )

/** The `permissions.deny` list of the worker's working copy `.cursor/cli.json`, as it is on disk now. */
function workerDeny(r: CursorRig): string[] {
  const cwd = workerStarts(r, 'session/new')[0]?.cwd
  if (cwd === undefined) return []
  const file = JSON.parse(readFileSync(join(cwd, '.cursor', 'cli.json'), 'utf8')) as {
    permissions: { deny: string[] }
  }
  return file.permissions.deny
}

const writeEntries = (deny: string[]): string[] => deny.filter((e) => e.startsWith('Write('))
const shellEntries = (deny: string[]): string[] => deny.filter((e) => e.startsWith('Shell('))

const OUTSIDE = '/opt/arc-skip-outside/elsewhere.txt'
const outsideEdit = (): object[] => [
  {
    emit: {
      sessionUpdate: 'tool_call',
      toolCallId: 'outside-1',
      title: 'Edit File',
      kind: 'edit',
      status: 'pending',
      rawInput: {}
    }
  },
  {
    emit: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'outside-1',
      title: `Edit \`${OUTSIDE}\``,
      rawInput: { path: OUTSIDE },
      locations: [{ path: OUTSIDE }]
    }
  },
  { emit: { sessionUpdate: 'tool_call_update', toolCallId: 'outside-1', status: 'in_progress' } },
  {
    emit: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'outside-1',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: OUTSIDE,
          oldText: '-- /dev/null',
          newText: `++ b/${OUTSIDE}\noutside.`
        }
      ]
    },
    delay: 60
  }
]

const commitNote: object[] = [
  { write: { path: 'cursor-note.txt', content: 'written by the fake Cursor\n' }, id: 'edit-1' },
  {
    shell:
      "git add -A && git -c user.name=Arc -c user.email=arc@example.com commit -q -m 'Add cursor note'",
    id: 'commit-1'
  }
]

test('015 2.5: skip turned on lifts the Cursor deny file at once and relaunches the worker at its turn boundary; an outside edit leaves no note and a push still docks', async () => {
  const scripts = writeScripts({
    // Turn one waits on a push request, so the toggle lands mid-turn; it ends without report_done, so Arc nudges.
    'worker-review.jsonl': [
      { expect: 'prompt' },
      { title: 'Add cursor note' },
      { text: 'Starting.' },
      {
        shell: PUSH,
        run: 'echo pushed',
        approval: true,
        id: 'push-1',
        saveAs: 'push'
      },
      { text: 'Pushed.' },
      { end: 'end_turn' }
    ],
    // The relaunched process (session/load) takes the nudge: an edit outside the working copy, then a second push.
    'worker-review-resumed.jsonl': [
      { expect: 'prompt' },
      { text: 'Carrying on.' },
      ...outsideEdit(),
      { shell: PUSH, run: 'echo pushed', approval: true, id: 'push-2', saveAs: 'push' },
      ...commitNote,
      { mcp: { tool: 'report_done', args: { summary: 'Added cursor-note.txt' } }, id: 'done-1' },
      { text: 'Done.' },
      { end: 'end_turn' }
    ]
  })
  const r = await launchCursorRig({
    cursorScenario: 'cr-push',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_SCRIPT_DIR: scripts }
  })
  rig = r
  const { page } = r
  const repo = r.repos['api']!
  await createGroupWithProjects(r, 'Storefront', [repo])
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })

  // Turn one is waiting on its push request. With skip off the deny file protects the project folder and the
  // knowledge folder, and carries the shell entries.
  const card = workerCard(page, W1)
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 20_000 })
  await expectWaiting(page, 1)
  const before = workerDeny(r)
  expect(writeEntries(before).length).toBeGreaterThan(1)
  expect(
    writeEntries(before).some((e) => [repo, realpathSync(repo)].some((p) => e === `Write(${p}/**)`))
  ).toBe(true)
  expect(shellEntries(before)).toContain('Shell(git push)')
  expect(shellEntries(before).length).toBeGreaterThan(3)

  await turnSkipOn(page)

  // The file is rewritten at once: only the attachments folder keeps its Write entry, and only the
  // publish-adjacent entries are gone with the rest of the Shell denies (no user Cursor config here).
  await expect
    .poll(() => writeEntries(workerDeny(r)).length)
    .toBeLessThan(writeEntries(before).length)
  const after = workerDeny(r)
  expect(writeEntries(after)).toHaveLength(1)
  expect(writeEntries(after)[0]).toMatch(/\/attachments\/\*\*\)$/)
  expect(shellEntries(after)).toEqual([])

  // The running process keeps its turn: nothing is relaunched while it waits on the request.
  await page.waitForTimeout(1500)
  expect(workerStarts(r, 'session/new')).toHaveLength(1)
  expect(workerStarts(r, 'session/load')).toHaveLength(0)
  // The request is still waiting: a push is not covered by skip.
  await expectWaiting(page, 1)
  await approve(request(page, 'permission'))
  await expectNoneWaiting(page)

  // Turn one ended with no report_done: at that boundary the worker is loaded again (session/load), with the nudge.
  await expect.poll(() => workerStarts(r, 'session/load').length).toBe(1)
  expect(workerStarts(r, 'session/new')).toHaveLength(1)
  await expect
    .poll(() => cursorAgents(r).filter((a) => a.role === 'worker' && a.resumed).length)
    .toBe(1)
  await expect.poll(() => cursorPrompts(r).filter((p) => p.role === 'worker').length).toBe(2)
  expect(cursorPrompts(r).filter((p) => p.role === 'worker')[1]!.text).toContain(
    'You have not called report_done'
  )

  // The second push is a request again, from the relaunched worker. The outside edit came first and left no note.
  await expectWaiting(page, 1, { timeout: 20_000 })
  await expect(request(page, 'permission').locator('pre[data-code]').first()).toHaveText(PUSH)
  expect(ranPush(r)).toBe(true) // push-1 only: push-2 is still waiting
  expect(cursorShellRuns(r).filter((s) => s.cmd === PUSH)).toHaveLength(1)
  await expect(
    eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })
  ).toHaveCount(0)
  expect(eventLog(page).filter({ hasText: OUTSIDE })).toHaveCount(0)
  // The relaunched process reads the same lifted file.
  expect(writeEntries(workerDeny(r))).toHaveLength(1)

  await approve(request(page, 'permission'))
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  await expect(
    eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })
  ).toHaveCount(0)
})

test('015 2.5: with a Cursor config that allows git push the publish entries stay and a blocked push says why', async () => {
  const scripts = writeScripts({
    // Cursor never asks about the push (Arc's kept deny stops it): pending -> in_progress -> completed, no output.
    'worker-review.jsonl': [
      { expect: 'prompt' },
      { title: 'Add cursor note' },
      { text: 'Starting.' },
      ...outsideEdit(),
      {
        emit: {
          sessionUpdate: 'tool_call',
          toolCallId: 'push-1',
          title: `\`${PUSH}\``,
          kind: 'execute',
          status: 'pending',
          rawInput: { command: PUSH }
        }
      },
      { emit: { sessionUpdate: 'tool_call_update', toolCallId: 'push-1', status: 'in_progress' } },
      {
        emit: { sessionUpdate: 'tool_call_update', toolCallId: 'push-1', status: 'completed' },
        delay: 60
      },
      { text: 'The push was not allowed.' },
      ...commitNote,
      { mcp: { tool: 'report_done', args: { summary: 'Added cursor-note.txt' } }, id: 'done-1' },
      { text: 'Done.' },
      { end: 'end_turn' }
    ]
  })
  const r = await launchCursorRig({
    cursorScenario: 'cr-blocked',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_SCRIPT_DIR: scripts },
    homeFiles: () => ({
      '.cursor/cli-config.json': JSON.stringify({ permissions: { allow: ['Shell(git push)'] } })
    })
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSkippingSession(page, 'Review the work')

  const note = eventLog(page).filter({ hasText: 'was blocked from pushing' })
  await expect(note).toHaveCount(1, { timeout: 20_000 })
  await expect(note).toHaveAttribute('data-event-kind', 'cursor-blocked')
  await expect(note).toContainText(
    'W1 was blocked from pushing. Your Cursor settings allow pushes without asking, so Arc keeps them blocked; run the push from Review changes.'
  )

  // The deny file lifts everything but the publish entries and the attachments folder.
  const deny = workerDeny(r)
  expect(shellEntries(deny)).toEqual(['Shell(git push)', 'Shell(gh)', 'Shell(glab)'])
  expect(writeEntries(deny)).toHaveLength(1)
  expect(writeEntries(deny)[0]).toMatch(/\/attachments\/\*\*\)$/)

  // The outside edit left no note of its own: the push note is the only Blocked entry. Nothing asked, nothing ran.
  await expect(
    eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })
  ).toHaveCount(1)
  expect(cursorPermissionAnswers(r)).toEqual([])
  expect(ranPush(r)).toBe(false)
  await expect(workerCard(page, W1)).toHaveAttribute('data-worker-card', /done|merged/, {
    timeout: 30_000
  })
})
