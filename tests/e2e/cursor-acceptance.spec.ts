// @spec: 010-cursor-as-a-third-provider
// @regression
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, test } from '@playwright/test'
import { chooseFromMenu, closeSettings, openSettings, providerRow, NEEDS_ATTENTION } from './codex-rig'
import { commandOption, composer } from './commands-rig'
import {
  cursorAgents,
  cursorPermissionAnswers,
  cursorSessions,
  cursorShellRuns,
  readCursorLog,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, git, startSession, workerCard } from './sessions-rig'
import { openUsagePanel } from './usage-rig'

/**
 * Spec 010 Slice 9: acceptance cases for the criteria the slice specs left to unit tests or to one half of the
 * behaviour. Each case drives the whole app: the brain is the fake Claude CLI and the workers are the fake Cursor in
 * `acp` mode. No model call is made and nothing outside the temporary HOME is touched.
 */
test.setTimeout(120_000)

/** Arc's model probe opens its Cursor session in `userData/cursor-probe`. */
const isProbe = (cwd: string | undefined): boolean => cwd?.endsWith('/cursor-probe') ?? false

let rig: CursorRig | undefined
let scratch: string | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  if (scratch) {
    // A case may leave a file unreadable on purpose.
    for (const file of readdirSync(scratch, { recursive: true, encoding: 'utf8' })) {
      try {
        chmodSync(join(scratch, file), statSync(join(scratch, file)).isDirectory() ? 0o755 : 0o644)
      } catch {
        // already gone
      }
    }
    rmSync(scratch, { recursive: true, force: true })
  }
  scratch = undefined
})

function scratchDir(prefix: string): string {
  scratch = mkdtempSync(join(tmpdir(), prefix))
  return scratch
}

/** The agent sessions of the workers (not the model probe, not the brain), in the order they started. */
const workerSessions = (r: CursorRig) =>
  cursorSessions(r).filter((s) => s.method === 'session/new' && !isProbe(s.cwd))

// ---- 2.4: edits outside the working copy -------------------------------------------------------------------------

test('2.4: a Cursor worker edit in the project folder is blocked with a note, another outside edit gets a note, and the deny file lists the folders Arc protects', async () => {
  const dir = scratchDir('arc-cursor-accept-')
  const outsideDir = join(dir, 'elsewhere')
  mkdirSync(outsideDir)
  const scripts = join(dir, 'scripts')
  mkdirSync(scripts)

  const r = await launchCursorRig({
    cursorScenario: 'ca-outside',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_SCRIPT_DIR: scripts }
  })
  rig = r
  const { page } = r
  const repo = r.repos['api']!
  const blockedFile = join(repo, 'blocked-by-deny.txt')
  const elsewhereFile = join(outsideDir, 'elsewhere.txt')

  // The review worker: an edit in the user's project folder that Cursor's Write deny stops (the shape recorded in
  // spike M6: the call completes at once with no diff and no output), a real write outside every known folder, and
  // an ordinary edit in its own working copy.
  writeFileSync(
    join(scripts, 'worker-review.jsonl'),
    [
      { expect: 'prompt' },
      { title: 'Edit around' },
      { text: 'Starting.' },
      {
        emit: {
          sessionUpdate: 'tool_call',
          toolCallId: 'deny-1',
          title: 'Edit File',
          kind: 'edit',
          status: 'pending',
          rawInput: {}
        }
      },
      {
        emit: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'deny-1',
          title: `Edit \`${blockedFile}\``,
          rawInput: { path: blockedFile },
          locations: [{ path: blockedFile }]
        }
      },
      { emit: { sessionUpdate: 'tool_call_update', toolCallId: 'deny-1', status: 'in_progress' } },
      {
        emit: { sessionUpdate: 'tool_call_update', toolCallId: 'deny-1', status: 'completed' },
        delay: 60
      },
      { write: { path: elsewhereFile, content: 'outside\n' }, id: 'edit-2' },
      { write: { path: 'inside.txt', content: 'inside\n' }, id: 'edit-3' },
      {
        shell: "git add -A && git -c user.name=Arc -c user.email=arc@example.com commit -q -m 'Add inside'",
        id: 'commit-1'
      },
      {
        mcp: { tool: 'report_done', args: { summary: 'Edited around' } },
        id: 'done-1'
      },
      { text: 'Done.' },
      { end: 'end_turn' }
    ]
      .map((step) => JSON.stringify(step))
      .join('\n') + '\n'
  )
  // The other worker only stays alive, so the review worker's deny file has to list its working copy.
  writeFileSync(
    join(scripts, 'worker-other.jsonl'),
    [{ expect: 'prompt' }, { text: 'Waiting.' }, { sleep: 90_000 }, { end: 'end_turn' }]
      .map((step) => JSON.stringify(step))
      .join('\n') + '\n'
  )

  await createGroupWithProjects(r, 'Storefront', [repo])
  await startSession(page, { request: 'Edit around', mode: 'Autonomous' })

  // The blocked edit: a Blocked note naming the worker and the file.
  const blocked = eventLog(page).filter({ hasText: 'blocked-by-deny.txt' })
  await expect(blocked).toHaveCount(1, { timeout: 30_000 })
  await expect(blocked).toHaveAttribute('data-event-kind', 'cursor-blocked')
  await expect(blocked).toContainText(
    `W1 couldn't change ${blockedFile}: Arc blocked it. Rerun this step on a Claude or Codex worker.`
  )

  // The other outside edit went through, so the session says so: a note naming the worker and the file.
  const changed = eventLog(page).filter({ hasText: 'elsewhere.txt' })
  await expect(changed).toHaveCount(1)
  await expect(changed).toHaveAttribute('data-event-kind', 'cursor-blocked')
  await expect(changed).toContainText(
    `W1 changed ${elsewhereFile} outside its working copy.`
  )

  // The edit in its own working copy needs no note: exactly the two notes above.
  await expect(eventLog(page).filter({ has: page.getByRole('img', { name: 'Blocked' }) })).toHaveCount(
    2
  )
  // Nothing was written to the user's project folder.
  expect(existsSync(blockedFile)).toBe(false)
  expect(git(repo, 'status', '--short')).toBe('')

  // What Arc handed Cursor to block it with: the review worker's deny file protects the project folder, the knowledge
  // folder and the other worker's working copy, and never its own.
  await expect.poll(() => workerSessions(r).length).toBe(2)
  const [review, other] = workerSessions(r)
  const denyOf = (cwd: string): string[] =>
    (
      JSON.parse(readFileSync(join(cwd, '.cursor', 'cli.json'), 'utf8')) as {
        permissions: { deny: string[] }
      }
    ).permissions.deny
  await expect
    .poll(() => denyOf(review!.cwd!).some((d) => d.includes(other!.cwd!)), { timeout: 15_000 })
    .toBe(true)
  const deny = denyOf(review!.cwd!)
  expect(deny.some((d) => d.startsWith('Write(') && d.includes(repo) && d.endsWith('/**)'))).toBe(
    true
  )
  expect(deny.some((d) => d.startsWith('Write(') && d.includes('/knowledge'))).toBe(true)
  expect(deny.filter((d) => d.includes(review!.cwd!))).toEqual([])
  expect(deny).toContain('Shell(git push)')
})

// ---- 2.5: suggestions cover Cursor agents --------------------------------------------------------------------------

test('2.5: a Cursor worker on a deep model that changed nothing gets a "Model too strong" suggestion, and one that changed a file does not', async () => {
  const dir = scratchDir('arc-cursor-accept-')
  const models = join(dir, 'models.json')
  writeFileSync(
    models,
    JSON.stringify([
      { modelId: 'default[]', name: 'Auto' },
      { modelId: 'claude-opus-5', name: 'Claude Opus 5' }
    ])
  )
  const r = await launchCursorRig({
    cursorScenario: 'ca-suggest',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_MODELS: models }
  })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Look, then add a note', mode: 'Autonomous' })

  // Cursor reports no tokens here, so only "changed nothing" can call the model too strong; the writer is left alone.
  await expect(workerCard(page, 'W1 · idle')).toHaveAttribute('data-worker-card', /done|merged/, {
    timeout: 45_000
  })
  await expect(workerCard(page, 'W2 · writer')).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    { timeout: 45_000 }
  )
  const panel = await openUsagePanel(page)
  const suggestion = panel.locator('[data-suggestion="model-too-strong"]')
  await expect(suggestion).toHaveCount(1, { timeout: 30_000 })
  await expect(suggestion).toContainText('Model too strong')
  await expect(suggestion).toContainText(
    'W1 used claude-opus-5 for a task that read 0 files and changed none.'
  )
  await expect(suggestion).not.toContainText('W2')
  // The advice names the model the suggestion points to in the words the user sees in the chooser, not an internal id.
  await expect(suggestion).not.toContainText('default[]')
  await expect(panel.locator('[data-suggestion]')).toHaveCount(1)
})

// ---- 2.8: a command file that can't be read -------------------------------------------------------------------------

const REVIEW = `---\ndescription: Review a change\nargument-hint: <what>\n---\nReview this change carefully: $ARGUMENTS\n`

test("2.8: a Cursor command whose file can't be read fails the worker with the reason and leaves no Cursor process running", async () => {
  const r = await launchCursorRig({
    cursorScenario: 'cc-run',
    repos: [{ name: 'api' }],
    cursor: {
      FAKE_CURSOR_COMMANDS: JSON.stringify([
        { name: 'review', description: 'Review a change (user)' }
      ])
    },
    homeFiles: () => ({ '.cursor/commands/review.md': REVIEW })
  })
  rig = r
  const { page } = r
  const file = join(r.home, '.cursor', 'commands', 'review.md')
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Review the retry change', mode: 'Autonomous' })
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()

  // The command is listed while its file can be read...
  await composer(page).fill('/rev')
  await expect(commandOption(page, 'review')).toBeVisible()
  // ...then the file becomes unreadable before the user runs it.
  chmodSync(file, 0o000)
  await composer(page).fill('/review the retry change')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(composer(page)).toHaveValue('')

  const card = workerCard(page, 'W1 · /review')
  await expect(card).toHaveAttribute('data-worker-card', 'failed', { timeout: 30_000 })
  const reason = `Arc could not read ${file} to run /review, so the worker was not started.`
  await expect(card).toContainText(reason)
  console.log('EVENTS', await eventLog(page).allTextContents())
  await expect(eventLog(page).filter({ hasText: `failed: ${reason}` })).toHaveCount(1)

  // The worker never got a message (a bare "/review" included).
  expect(readCursorLog(r).filter((l) => (l['recv'] as { method?: string })?.method === 'session/prompt')).toEqual([])

  // The Cursor process Arc had started for it is gone: no live process among those that opened a worker session.
  const pids = [
    ...new Set(
      readCursorLog(r).flatMap((l) => {
        const s = l['session'] as { method?: string; cwd?: string } | undefined
        return s?.method === 'session/new' && !isProbe(s.cwd) ? [l['pid'] as number] : []
      })
    )
  ]
  expect(pids.length).toBeGreaterThanOrEqual(1)
  await expect
    .poll(() => pids.filter(alive), { timeout: 10_000, message: 'a Cursor process is still running' })
    .toEqual([])
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- 2.7: nothing in the user's Cursor setup changes ------------------------------------------------------------------

const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')

/** Every file under `root` (relative path to the sha256 of its content); `privacyCache.updatedAt` is left out of cli-config.json, which Cursor itself bumps. */
function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!existsSync(root)) return out
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    const path = join(root, entry)
    if (statSync(path).isDirectory()) {
      out[`${relative(root, path)}/`] = 'dir'
      continue
    }
    let content: string | Buffer = readFileSync(path)
    if (entry === 'cli-config.json') {
      const parsed = JSON.parse(content.toString('utf8')) as { privacyCache?: Record<string, unknown> }
      if (parsed.privacyCache) delete parsed.privacyCache['updatedAt']
      content = JSON.stringify(parsed)
    }
    out[relative(root, path)] = sha256(content)
  }
  return out
}

const USER_CURSOR_FILES: Record<string, string> = {
  '.cursor/mcp.json': JSON.stringify({ mcpServers: { fakeuser: { command: 'node', args: [] } } }, null, 2),
  '.cursor/cli-config.json': JSON.stringify(
    {
      version: 1,
      permissions: { allow: ['Shell(ls)'], deny: [] },
      privacyCache: { ghostMode: false, privacyMode: 1, updatedAt: 1760000000000 }
    },
    null,
    2
  ),
  '.cursor/commands/review.md': REVIEW,
  '.cursor/rules/style.mdc': '---\nalwaysApply: true\n---\nKeep functions short.\n',
  '.cursor/skills/triage/SKILL.md': '---\nname: triage\ndescription: Triage\n---\nTriage the issue.\n'
}

test("2.7: after a whole Cursor session (Providers, Agent loading, an approved push, usage) every file under the user's ~/.cursor and the project checkout are as they were", async () => {
  const r = await launchCursorRig({
    cursorScenario: 'cr-push',
    repos: [{ name: 'api' }],
    cursor: { FAKE_CURSOR_USAGE: 'prompt' },
    homeFiles: () => USER_CURSOR_FILES
  })
  rig = r
  const { page } = r
  const repo = r.repos['api']!
  const cursorHome = join(r.home, '.cursor')
  const before = treeHashes(cursorHome)
  expect(Object.keys(before)).toEqual(
    expect.arrayContaining([
      'mcp.json',
      'cli-config.json',
      'commands/review.md',
      'rules/style.mdc',
      'skills/triage/SKILL.md'
    ])
  )

  // Providers: Check again; Agent loading: the Cursor group.
  await openSettings(page)
  await providerRow(page, 'cursor').getByRole('button', { name: 'Check Cursor again' }).click()
  await expect(providerRow(page, 'cursor').locator('[data-provider-status]')).toContainText(
    'Cursor · signed in'
  )
  await page.locator('[data-settings] nav').getByRole('button', { name: 'Agent loading' }).click()
  await expect(page.getByRole('heading', { name: 'Cursor MCP servers' })).toBeVisible()
  await closeSettings(page)

  // A session: the worker's push waits in Needs attention and runs after Approve.
  await createGroupWithProjects(r, 'Storefront', [repo])
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  const card = workerCard(page, 'W1 · review')
  await expect(card).toHaveAttribute('data-worker-card', 'needs_approval', { timeout: 30_000 })
  await page.getByRole('button', { name: NEEDS_ATTENTION }).click()
  await page
    .getByRole('dialog', { name: /Needs attention/ })
    .getByRole('button', { name: 'Approve', exact: true })
    .click()
  await expect.poll(() => cursorShellRuns(r).some((s) => s.cmd === 'git push origin HEAD')).toBe(true)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  expect(cursorPermissionAnswers(r).map((a) => a.optionId)).toEqual(['allow-once'])
  expect(cursorAgents(r).length).toBeGreaterThanOrEqual(1)

  // Cursor settings: every file and folder is as it was, and nothing was added.
  expect(treeHashes(cursorHome)).toEqual(before)
  // The project checkout never got a Cursor file (Arc's deny file lives in the worker's own working copy).
  expect(existsSync(join(repo, '.cursor'))).toBe(false)
  expect(git(repo, 'status', '--short')).toBe('')
})

// ---- 2.2: the session's own Workers choice ----------------------------------------------------------------------------

test("2.2: choosing Cursor in the session's Workers menu makes the brain's next worker a Cursor worker whose card shows Cursor and its model", async () => {
  const r = await launchCursorRig({ cursorScenario: 'cr-worker', repos: [{ name: 'api' }] })
  rig = r
  const { page } = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(page, { request: 'Review the work', mode: 'Autonomous' })
  await expect(page.getByText('Ready when you are.')).toBeVisible()

  // The session's chooser offers Cursor and its Auto model next to Claude and Codex.
  await page.getByRole('button', { name: 'Worker model' }).click()
  await expect(page.getByRole('menuitemradio', { name: 'Claude', exact: true })).toBeVisible()
  await expect(page.getByRole('menuitemradio', { name: 'Cursor', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await chooseFromMenu(page, 'Worker model', 'Cursor')
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Cursor/i)

  await page.getByPlaceholder('Message the brain').fill('go')
  await page.getByPlaceholder('Message the brain').press('Enter')
  const card = workerCard(page, 'W1 · review')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  expect(cursorAgents(r)).toEqual([
    expect.objectContaining({ role: 'worker', slug: 'review', resumed: false })
  ])
})
