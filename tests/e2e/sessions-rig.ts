import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { e2eEnv, mainWindow } from './fixtures'
import { git, gitFixtureEnv } from '../helpers/git-fixtures'

/** Shared plumbing for the spec 003 acceptance specs: fixture repositories, the fake Claude CLI and Arc launches. */

const FAKE_CLAUDE = resolve('tests/e2e/fixtures/fake-claude.mjs')
const SCENARIOS = resolve('tests/e2e/fixtures/claude-scenarios')

export type RepoKind = 'clean' | 'dirty' | 'no-dev' | 'plain'

export interface RepoSpec {
  name: string
  kind?: RepoKind
}

export interface RigOptions {
  /** A scenario directory (per-role scripts) or a `.jsonl` file under claude-scenarios. */
  scenario: string
  auth?: 'ok' | 'out'
  /** Defaults to two clean repositories, api and web, on `dev`. */
  repos?: RepoSpec[]
  group?: string
  /** Extra environment for the launch. */
  env?: Record<string, string>
}

export interface Rig {
  app: ElectronApplication
  page: Page
  root: string
  userDataDir: string
  /** Absolute path of each fixture project, by name. */
  repos: Record<string, string>
  /** The fake CLI's JSON-lines log (argv, stdin, shell and permission records). */
  logPath: string
  /** Quit Arc gracefully (the will-quit shutdown path runs) and launch it again on the same data. */
  relaunch(next?: { scenario?: string }): Promise<void>
  /** SIGKILL Arc, as a crash would, and launch it again on the same data. */
  crashAndRelaunch(next?: { scenario?: string }): Promise<void>
  /** Close Arc without relaunching. */
  close(): Promise<void>
  /** Remove every temporary directory. */
  dispose(): Promise<void>
}

function makeRepo(root: string, spec: RepoSpec): string {
  const path = join(root, spec.name)
  mkdirSync(path)
  const kind = spec.kind ?? 'clean'
  if (kind === 'plain') {
    execFileSync('sh', ['-c', `echo "not a repo" > note.txt`], { cwd: path })
    return path
  }
  git(path, 'init', '-b', kind === 'no-dev' ? 'main' : 'dev')
  execFileSync('sh', ['-c', `printf 'hello\\n' > README.md`], { cwd: path })
  git(path, 'add', 'README.md')
  git(path, 'commit', '-m', 'Initial commit')
  if (kind === 'dirty') {
    execFileSync(
      'sh',
      ['-c', `printf 'hello\\nchanged\\n' > README.md; echo new > untracked.txt`],
      {
        cwd: path
      }
    )
  }
  return path
}

function launchEnv(
  userDataDir: string,
  options: RigOptions,
  logPath: string
): Record<string, string> {
  const scenario = options.scenario
  const isFile = scenario.endsWith('.jsonl')
  const env: Record<string, string> = {
    ...e2eEnv(userDataDir),
    HARNESS_CLAUDE_BIN: FAKE_CLAUDE,
    FAKE_CLAUDE_AUTH: options.auth ?? 'ok',
    FAKE_CLAUDE_LOG: logPath,
    GIT_AUTHOR_NAME: gitFixtureEnv['GIT_AUTHOR_NAME'] ?? 'Arc Test',
    GIT_AUTHOR_EMAIL: gitFixtureEnv['GIT_AUTHOR_EMAIL'] ?? 'arc-test@example.com',
    GIT_COMMITTER_NAME: gitFixtureEnv['GIT_COMMITTER_NAME'] ?? 'Arc Test',
    GIT_COMMITTER_EMAIL: gitFixtureEnv['GIT_COMMITTER_EMAIL'] ?? 'arc-test@example.com',
    ...(isFile
      ? { FAKE_CLAUDE_SCRIPT: join(SCENARIOS, scenario) }
      : { FAKE_CLAUDE_SCRIPT_DIR: join(SCENARIOS, scenario) }),
    ...options.env
  }
  return env
}

async function stubProjects(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate((_, p) => {
    ;(
      globalThis as unknown as { __e2e: { queueOpenDialog(p: string[]): void } }
    ).__e2e.queueOpenDialog(p)
  }, paths)
}

/** Creates the group and adds the fixture projects, then leaves the Sessions tab open. */
export async function createGroupWithProjects(
  rig: Pick<Rig, 'app' | 'page'>,
  group: string,
  paths: string[]
): Promise<void> {
  const { app, page } = rig
  await page.getByRole('button', { name: 'New Group' }).click()
  await page.getByLabel('Group name').fill(group)
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('heading', { name: group })).toBeVisible()
  if (paths.length > 0) {
    await page.getByRole('tab', { name: 'Projects' }).click()
    for (const path of paths) {
      await stubProjects(app, [path])
      await page.getByRole('button', { name: 'Add Project' }).click()
      await expect(page.getByRole('list', { name: 'Projects' }).getByText(path)).toBeVisible()
    }
    await page.getByRole('tab', { name: 'Sessions' }).click()
  }
}

export async function launchRig(options: RigOptions): Promise<Rig> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arc-s3-')))
  const userDataDir = join(root, 'userdata')
  mkdirSync(userDataDir)
  const logPath = join(root, 'fake-claude.log')
  await writeFile(logPath, '')
  const repoSpecs = options.repos ?? [{ name: 'api' }, { name: 'web' }]
  const repoRoot = join(root, 'projects')
  mkdirSync(repoRoot)
  const repos: Record<string, string> = {}
  for (const spec of repoSpecs) repos[spec.name] = makeRepo(repoRoot, spec)

  const rig = {
    root,
    userDataDir,
    repos,
    logPath
  } as Rig

  let current = options
  const start = async (): Promise<void> => {
    rig.app = await electron.launch({
      args: ['out/main/index.js'],
      env: launchEnv(userDataDir, current, logPath)
    })
    rig.page = await mainWindow(rig.app)
  }
  const stop = async (): Promise<void> => {
    const child = rig.app.process()
    let timer: ReturnType<typeof setTimeout> | undefined
    const closed = await Promise.race([
      rig.app.close().then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), 15_000)
      })
    ]).catch(() => false)
    clearTimeout(timer)
    if (!closed) child.kill('SIGKILL')
  }

  await start()
  rig.relaunch = async (next) => {
    await stop()
    if (next?.scenario) current = { ...options, scenario: next.scenario }
    await start()
  }
  rig.crashAndRelaunch = async (next) => {
    rig.app.process().kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 500))
    if (next?.scenario) current = { ...options, scenario: next.scenario }
    await start()
  }
  rig.close = stop
  rig.dispose = async () => {
    await stop()
    await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  return rig
}

/** Parsed lines of the fake CLI log. */
export function readFakeLog(rig: Pick<Rig, 'logPath'>): Record<string, unknown>[] {
  if (!existsSync(rig.logPath)) return []
  return readFileSync(rig.logPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

export interface StartOptions {
  request: string
  mode?: 'Plan-first' | 'Autonomous'
  limit?: number
}

/** Opens the New Session dialog, fills it and clicks Start. */
export async function startSession(page: Page, options: StartOptions): Promise<void> {
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Request').fill(options.request)
  if (options.mode) await dialog.getByLabel(options.mode, { exact: false }).check()
  if (options.limit !== undefined) {
    await dialog.getByLabel('Worker limit').selectOption(String(options.limit))
  }
  await dialog.getByRole('button', { name: 'Start' }).click()
}

export function eventLog(page: Page) {
  return page.locator('[data-event-log] li')
}

export function workerCard(page: Page, title: string) {
  return page.locator('[data-worker-card]').filter({ hasText: title })
}

export { git }
