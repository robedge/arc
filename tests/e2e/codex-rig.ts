import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { launchRig } from './sessions-rig'
import type { Rig, RigOptions } from './sessions-rig'

/**
 * Plumbing for the spec 007 acceptance specs: the fake Codex app-server next to the fake Claude CLI, a temporary
 * HOME and CODEX_HOME (the real ~/.claude, ~/.claude.json and ~/.codex are never read), and a wrapper script so a
 * test can change what the "installed" Codex says (signed in or out, its version, its models) while Arc runs.
 */

export const FAKE_CODEX = resolve('tests/e2e/fixtures/fake-codex.mjs')
export const FAKE_CURSOR = resolve('tests/e2e/fixtures/fake-cursor.mjs')
export const FAKE_MCP = resolve('tests/e2e/fixtures/fake-mcp.mjs')
const CODEX_SCENARIOS = resolve('tests/e2e/fixtures/codex-scenarios')

export interface CodexRigOptions extends RigOptions {
  /** A directory under codex-scenarios (per-role scripts). Omit for the fake's default one-turn script. */
  codexScenario?: string
  /** The first state of the fake Codex: FAKE_CODEX_* variables (see the header of fake-codex.mjs). */
  codex?: Record<string, string>
  /** The first state of the fake Cursor: FAKE_CURSOR_* variables (see the header of fake-cursor.mjs). */
  cursor?: Record<string, string>
  /** False points HARNESS_CURSOR_BIN at a path that does not exist. */
  cursorInstalled?: boolean
  /** `missing` points HARNESS_CODEX_BIN at a path that does not exist. */
  codexInstalled?: boolean
  /** The newest published versions the update check sees (HARNESS_PROVIDER_LATEST_FILE). */
  latest?: { claude?: string; codex?: string }
  /** Files to write under the temporary HOME before Arc starts: relative path to text. */
  homeFiles?: (paths: { home: string; codexHome: string }) => Record<string, string>
}

export interface CodexRig extends Rig {
  /** The temporary HOME (Arc reads os.homedir(), which honours it). */
  home: string
  codexHome: string
  /** Where Arc's fake Codex process logs (argv, recv, send, thread, mcpResult, shell). */
  codexLogPath: string
  /** Changes what the next fake Codex process says, for example `{ FAKE_CODEX_AUTH: 'ok' }`. */
  setCodex(patch: Record<string, string>): void
  /** Changes what the next fake Cursor process says, for example `{ FAKE_CURSOR_AUTH: 'ok' }`. */
  setCursor(patch: Record<string, string>): void
  /** Changes the newest published versions the next update check sees. */
  setLatest(latest: { claude?: string; codex?: string }): void
  /** Removes the Codex program, as if the user had uninstalled it (the next Arc start finds none). */
  uninstallCodex(): void
}

function shq(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** Launches Arc with both fakes. The returned rig removes its own support directory on dispose. */
export async function launchCodexRig(options: CodexRigOptions): Promise<CodexRig> {
  const support = await realpath(await mkdtemp(join(tmpdir(), 'arc-s10-')))
  const home = join(support, 'home')
  const codexHome = join(home, '.codex')
  mkdirSync(codexHome, { recursive: true })
  for (const [path, text] of Object.entries(options.homeFiles?.({ home, codexHome }) ?? {})) {
    const file = join(home, path)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, text)
  }

  // The wrapper reads its state file on every run, so a test can change the answers while Arc is running.
  const stateFile = join(support, 'codex-state.sh')
  const writeState = (state: Record<string, string>): void => {
    writeFileSync(
      stateFile,
      Object.entries(state)
        .map(([k, v]) => `export ${k}=${shq(v)}\n`)
        .join('')
    )
  }
  let codexState: Record<string, string> = { ...options.codex }
  writeState(codexState)
  const wrapper = join(support, 'codex')
  writeFileSync(
    wrapper,
    `#!/bin/sh\n. ${shq(stateFile)}\nexec ${shq(process.execPath)} ${shq(FAKE_CODEX)} "$@"\n`
  )
  chmodSync(wrapper, 0o755)

  const cursorStateFile = join(support, 'cursor-state.sh')
  const writeCursorState = (state: Record<string, string>): void => {
    writeFileSync(
      cursorStateFile,
      Object.entries(state)
        .map(([k, v]) => `export ${k}=${shq(v)}\n`)
        .join('')
    )
  }
  let cursorState: Record<string, string> = { ...options.cursor }
  writeCursorState(cursorState)
  const cursorWrapper = join(support, 'cursor-agent')
  writeFileSync(
    cursorWrapper,
    `#!/bin/sh\n. ${shq(cursorStateFile)}\nexec ${shq(process.execPath)} ${shq(FAKE_CURSOR)} "$@"\n`
  )
  chmodSync(cursorWrapper, 0o755)

  const latestFile = join(support, 'latest.json')
  let latest = { ...options.latest }
  writeFileSync(latestFile, JSON.stringify(latest))
  const codexLogPath = join(support, 'fake-codex.log')
  writeFileSync(codexLogPath, '')

  const rig = (await launchRig({
    ...options,
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      HARNESS_CODEX_BIN: options.codexInstalled === false ? join(support, 'no-codex') : wrapper,
      HARNESS_CURSOR_BIN:
        options.cursorInstalled === false ? join(support, 'no-cursor') : cursorWrapper,
      HARNESS_PROVIDER_LATEST_FILE: latestFile,
      FAKE_CODEX_LOG: codexLogPath,
      ...(options.codexScenario
        ? { FAKE_CODEX_SCRIPT_DIR: join(CODEX_SCENARIOS, options.codexScenario) }
        : {}),
      ...options.env
    }
  })) as CodexRig

  rig.home = home
  rig.codexHome = codexHome
  rig.codexLogPath = codexLogPath
  rig.setCodex = (patch) => {
    codexState = { ...codexState, ...patch }
    writeState(codexState)
  }
  rig.setCursor = (patch) => {
    cursorState = { ...cursorState, ...patch }
    writeCursorState(cursorState)
  }
  rig.uninstallCodex = () => {
    rmSync(wrapper, { force: true })
  }
  rig.setLatest = (next) => {
    latest = { ...latest, ...next }
    writeFileSync(latestFile, JSON.stringify(latest))
  }
  const dispose = rig.dispose
  rig.dispose = async () => {
    await dispose()
    await rm(support, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
  return rig
}

/** Parsed lines of the fake Codex log. */
export function readCodexLog(rig: Pick<CodexRig, 'codexLogPath'>): Record<string, unknown>[] {
  if (!existsSync(rig.codexLogPath)) return []
  return readFileSync(rig.codexLogPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/**
 * The `turn/start` requests Arc sent to the fake Codex, as { threadId, model, text }. The model is the one on the turn
 * (a switch inside a running thread) or else the one the thread was started or resumed with.
 */
export function codexTurns(
  rig: Pick<CodexRig, 'codexLogPath'>
): { model?: string; text: string; threadId?: string }[] {
  let started: string | undefined
  const turns: { model?: string; text: string; threadId?: string }[] = []
  for (const l of readCodexLog(rig)) {
    const recv = l['recv'] as
      | { method?: string; params?: { model?: string; threadId?: string; input?: unknown } }
      | undefined
    if (
      (recv?.method === 'thread/start' || recv?.method === 'thread/resume') &&
      recv.params?.model
    ) {
      started = recv.params.model
    }
    if (recv?.method !== 'turn/start') continue
    const threadId = recv.params?.threadId
    const model = recv.params?.model ?? started
    turns.push({
      ...(model ? { model } : {}),
      ...(threadId ? { threadId } : {}),
      text: JSON.stringify(recv.params?.input ?? '')
    })
  }
  return turns
}

export interface CodexThread {
  method: string
  role?: string
  slug?: string
  model?: string
  /** The version the fake Codex process announced in its initialize answer (`arc/<version> ...`). */
  version?: string
}

/** Every thread Arc started or resumed on the fake Codex, in order, with the version of the process that served it. */
export function codexThreads(rig: Pick<CodexRig, 'codexLogPath'>): CodexThread[] {
  const out: CodexThread[] = []
  let version: string | undefined
  for (const l of readCodexLog(rig)) {
    if ('argv' in l) version = undefined
    const sent = l['send'] as { result?: { userAgent?: string } } | undefined
    const agent = sent?.result?.userAgent
    if (typeof agent === 'string') version = /^arc\/(\S+)/.exec(agent)?.[1]
    const t = l['thread'] as Omit<CodexThread, 'version'> | undefined
    if (t) {
      out.push({
        method: t.method,
        ...(t.role ? { role: t.role } : {}),
        ...(t.slug ? { slug: t.slug } : {}),
        ...(t.model ? { model: t.model } : {}),
        ...(version ? { version } : {})
      })
    }
  }
  return out
}

// ---- UI helpers ----------------------------------------------------------------------------

export async function openSettings(page: Page): Promise<void> {
  if (!(await page.locator('[data-settings]').isVisible())) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible()
}

export async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-settings]')).toHaveCount(0)
}

export const providerRow = (page: Page, provider: 'claude' | 'codex' | 'cursor'): Locator =>
  page.locator(`[data-provider="${provider}"]`)

/** Picks an item of a header menu (`Brain model`, `Worker model`). */
export async function chooseFromMenu(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole('button', { name: menu }).click()
  await page.getByRole('menuitemradio', { name: item, exact: true }).click()
}

export const NEEDS_ATTENTION = /Needs attention, \d+ waiting/

/** Settings > Providers > a default picker ("Default brain" or "Default workers"), then back to the previous screen. */
export async function setDefault(page: Page, picker: string, label: string): Promise<void> {
  await openSettings(page)
  await page.getByLabel(picker).selectOption({ label })
  await expect(page.getByLabel(picker).locator('option:checked')).toHaveText(label)
  await closeSettings(page)
}
