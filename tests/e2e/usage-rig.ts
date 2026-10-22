import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import type { Rig } from './sessions-rig'

/**
 * Plumbing for the spec 008 acceptance specs (plan usage and token spend): the fake CLIs come from the spec 007 rig
 * (codex-rig.ts); this file adds a way to seed or read Arc's database while Arc is not looking, and small readers for
 * the token numbers the UI shows.
 */

export const FAKE_CLAUDE_PATH = resolve('tests/e2e/fixtures/fake-claude.mjs')
const SQLITE_EXEC = resolve('tests/e2e/fixtures/sqlite-exec.mjs')

let electronBinary: string | undefined
function electronPath(): string {
  electronBinary ??= execFileSync(process.execPath, ['-p', "require('electron')"], {
    cwd: resolve('.')
  })
    .toString()
    .trim()
  return electronBinary
}

export interface SqlJob {
  sql: string
  params?: (string | number | null)[]
}

/**
 * Runs SQL against the rig's `arc.db` under Electron's own Node (better-sqlite3 is built for it). The database runs in
 * WAL mode, so this is safe while Arc is open; callers relaunch Arc afterwards so it reads the new rows fresh.
 */
export function sql(rig: Pick<Rig, 'userDataDir'>, jobs: SqlJob[]): Record<string, unknown>[][] {
  const dir = mkdtempSync(join(tmpdir(), 'arc-s8-'))
  try {
    const file = join(dir, 'jobs.json')
    writeFileSync(file, JSON.stringify(jobs))
    const out = execFileSync(electronPath(), [SQLITE_EXEC, join(rig.userDataDir, 'arc.db'), file], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    return JSON.parse(out.toString()) as Record<string, unknown>[][]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** One query, rows back. */
export function query(
  rig: Pick<Rig, 'userDataDir'>,
  text: string,
  params: (string | number | null)[] = []
): Record<string, unknown>[] {
  return sql(rig, [{ sql: text, params }])[0] ?? []
}

/** Local `YYYY-MM-DD` for today minus `daysAgo`, the way Arc stores `usage_turns.day`. */
export function localDay(daysAgo: number): string {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Noon of that local day, as epoch milliseconds. */
export function noonOf(daysAgo: number): number {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

// ---- readers -------------------------------------------------------------------------------

/** The exact number a `TokenCount` element carries (its `data-tokens`). */
export async function tokensOf(count: Locator): Promise<number> {
  const raw = await count.getAttribute('data-tokens')
  if (raw === null) throw new Error('not a recorded token count')
  return Number(raw)
}

/** Every recorded token count inside a locator, as numbers, in document order. */
export async function allTokens(scope: Locator): Promise<number[]> {
  const raws = await scope
    .locator('[data-tokens]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-tokens')))
  return raws.map((r) => Number(r))
}

export const usageChip = (page: Page): Locator => page.locator('[data-usage-chip]')
export const usagePanel = (page: Page): Locator => page.locator('[data-usage-panel]')

/** The chip's total as a number. */
export function chipTotal(page: Page): Promise<number> {
  return tokensOf(usageChip(page).locator('[data-token-count]'))
}

export async function openUsagePanel(page: Page): Promise<Locator> {
  if (!(await usagePanel(page).isVisible())) await usageChip(page).click()
  await expect(usagePanel(page)).toBeVisible()
  return usagePanel(page)
}

export async function openUsagePage(page: Page): Promise<Locator> {
  if (!(await page.locator('[data-usage-view]').isVisible())) {
    await page.locator('[data-usage-button]').click()
  }
  const view = page.locator('[data-usage-view]')
  await expect(view).toBeVisible()
  return view
}

export async function closeUsagePage(page: Page): Promise<void> {
  await page.locator('[data-usage-view]').getByRole('button', { name: 'Back' }).click()
  await expect(page.locator('[data-usage-view]')).toHaveCount(0)
}

/** Picks a range on the Usage page and waits until the page shows it. */
export async function pickRange(page: Page, range: 'today' | '7d' | '30d' | 'all'): Promise<void> {
  await page.locator(`[data-range="${range}"]`).click()
  await expect(page.locator(`[data-range="${range}"]`)).toHaveAttribute('aria-checked', 'true')
}

/** Resizes the main window (the content size) of a running Arc. */
export async function resizeWindow(
  rig: Pick<Rig, 'app'>,
  width: number,
  height: number
): Promise<void> {
  await rig.app.evaluate(
    ({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('/index.html')
      )
      win?.setContentSize(size.width, size.height)
    },
    { width, height }
  )
}

/** "as of 2:10 PM" as minutes since midnight, or null when the text has no such time. */
export function asOfMinutes(text: string): number | null {
  const m = /as of (\d{1,2}):(\d{2})\s*([AP]M)/i.exec(text)
  if (!m) return null
  const hour = Number(m[1]) % 12
  return (hour + (m[3]!.toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(m[2])
}

/** Minutes since midnight now. */
export function nowMinutes(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

/** After a relaunch: selects the group and opens its first session. */
export async function reopenSession(page: Page, group: string, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: group })
    .click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-name]')).toHaveText(name)
}

const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' })

/** The reset time as the UI words it: "3:40 PM" today, "Mon 3:40 PM" on another day. `sec` is epoch seconds. */
export function resetText(sec: number): string {
  const at = new Date(sec * 1000)
  const now = new Date()
  const today = at.toDateString() === now.toDateString()
  return today ? clock.format(at) : `${weekday.format(at)} ${clock.format(at)}`
}

/** Epoch seconds `minutes` from now, rounded down to a whole minute. */
export function inMinutes(minutes: number): number {
  return Math.floor(Date.now() / 60_000) * 60 + minutes * 60
}

// ---- seeded usage history ------------------------------------------------------------------

export interface SeedTurn {
  /** `brain`, or a worker id. */
  agent: string
  role: 'brain' | 'worker'
  provider: 'claude' | 'codex'
  model: string
  /** Days before today (0 = today). */
  daysAgo: number
  /** The turn's total tokens: 10% input, 10% cache write, 70% cache read, 10% output. */
  total: number
  command?: string
  workerLabel?: string
}

export interface SeedSession {
  id: string
  name: string
  daysAgo: number
  turns: SeedTurn[]
}

/** The group created by the rig, as `{ id, name }`. */
export function groupOf(rig: Pick<Rig, 'userDataDir'>): { id: string; name: string } {
  const row = query(rig, 'SELECT id, name FROM groups')[0]!
  return { id: row['id'] as string, name: row['name'] as string }
}

/**
 * Writes stopped sessions and their usage turns straight into Arc's database, so a test can look at a week of history
 * without running a week of sessions. Call `relaunch()` afterwards.
 */
export function seedHistory(rig: Pick<Rig, 'userDataDir'>, sessions: SeedSession[]): void {
  const group = groupOf(rig)
  const jobs: SqlJob[] = []
  for (const s of sessions) {
    const created = noonOf(s.daysAgo)
    jobs.push({
      sql: `INSERT INTO sessions (id, group_id, name, mode, worker_limit, status, created_at, last_active_at)
            VALUES (?, ?, ?, 'autonomous', 3, 'stopped', ?, ?)`,
      params: [s.id, group.id, s.name, created, created]
    })
    for (const t of s.turns) {
      const tenth = Math.round(t.total / 10)
      jobs.push({
        sql: `INSERT INTO usage_turns (session_id, agent_key, agent_role, worker_id, provider, model, command,
                session_name, group_id, group_name, worker_label, at, day, input_tokens, cache_write_tokens,
                cache_read_tokens, output_tokens, max_call_input, call_count, source)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'turn')`,
        params: [
          s.id,
          t.agent,
          t.role,
          t.role === 'worker' ? t.agent : null,
          t.provider,
          t.model,
          t.command ?? null,
          s.name,
          group.id,
          group.name,
          t.workerLabel ?? null,
          noonOf(t.daysAgo),
          localDay(t.daysAgo),
          tenth,
          tenth,
          t.total - 3 * tenth,
          tenth,
          Math.round(t.total / 2)
        ]
      })
    }
  }
  sql(rig, jobs)
}
