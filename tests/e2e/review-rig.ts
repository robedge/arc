import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { createGroupWithProjects, git, launchRig, startSession, workerCard } from './sessions-rig'
import type { Rig } from './sessions-rig'

/** Shared plumbing for the spec 004 acceptance specs (scenario `review-main`). */

export const SCENARIO = 'review-main'

/** The session's review button in the header ("Review changes · 12"), not the link after the summary. */
export const reviewButton = (page: Page): Locator =>
  page.locator('[data-session-screen]').getByRole('button', { name: /^Review changes · \d+$/ })

export const reviewScreen = (page: Page): Locator => page.locator('[data-review-screen]')

/** A repository group in the review's file list. */
export const repoGroup = (page: Page, name: string): Locator =>
  page.locator('[data-review-file-list]').getByRole('region', { name, exact: true })

/** One file row in a repository group (session files by default). */
export const fileRow = (
  page: Page,
  repo: string,
  path: string,
  source: 'session' | 'uncommitted' = 'session'
): Locator =>
  repoGroup(page, repo).locator(`[data-review-file="${path}"][data-review-source="${source}"]`)

export function sessionBranch(path: string): string {
  return git(path, 'branch', '--list', 'arc/*', '--format=%(refname:short)').trim().split('\n')[0]!
}

/**
 * Launches Arc on two repositories (api, web) whose `dev` already holds a 12-line config.txt, creates the
 * group and starts an autonomous session whose brain waits for the user to say SPAWN.
 */
export async function launchReviewRig(): Promise<Rig> {
  const rig = await launchRig({ scenario: SCENARIO, repos: [{ name: 'api' }, { name: 'web' }] })
  const api = rig.repos['api']!
  writeFileSync(
    join(api, 'config.txt'),
    Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  )
  git(api, 'add', 'config.txt')
  git(api, 'commit', '-m', 'Add config')
  await createGroupWithProjects(rig, 'Storefront', [api, rig.repos['web']!])
  await startSession(rig.page, { request: 'Fix order sync', mode: 'Autonomous', limit: 6 })
  await expect(rig.page.locator('[data-session-screen]')).toBeVisible()
  return rig
}

/** Tells the brain to start its workers and waits for the three that finish by themselves to be merged. */
export async function spawnAndMerge(rig: Pick<Rig, 'page' | 'repos'>): Promise<void> {
  const { page } = rig
  await page.getByLabel('Message to the brain').fill('SPAWN')
  await page.getByRole('button', { name: 'Send' }).click()
  // W2 (web) is held back until W1 is merged, so the brain's notes about the merges arrive in a known order.
  await expect(workerCard(page, 'W1 · api-core')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 60_000
  })
  openGate(rig, 'web')
  for (const title of ['W2 · web-ui', 'W3 · api-tune']) {
    await expect(workerCard(page, title)).toHaveAttribute('data-worker-card', 'merged', {
      timeout: 60_000
    })
  }
  // The brain shares W1's change with W3 once W1 is merged; W4 waits for the gate.
  await expect(page.getByText('Shared the queue with W3.')).toBeVisible()
}

/** Lets a gated worker go: W4 (api-late) in api, or W2 (web-ui) in web. */
export function openGate(rig: Pick<Rig, 'repos'>, repo: 'api' | 'web' = 'api'): void {
  writeFileSync(join(rig.repos[repo]!, '.git', 'arc-gate'), 'go\n')
}

/** Opens the review from the session header; does nothing when it is already open. */
export async function openReview(page: Page): Promise<void> {
  if (!(await reviewScreen(page).isVisible())) await reviewButton(page).click()
  await expect(reviewScreen(page)).toBeVisible()
}

/** Back to the conversation; does nothing when the review is not open. */
export async function closeReview(page: Page): Promise<void> {
  if (await reviewScreen(page).isVisible()) {
    await page.getByRole('button', { name: 'Back to session' }).click()
  }
  await expect(reviewScreen(page)).toHaveCount(0)
}

/**
 * Background colour of an element as red/green/blue over a mid-grey page, read through a canvas so any CSS
 * colour syntax (including colour-mix with transparency) resolves.
 */
export async function paintedColour(
  locator: Locator
): Promise<{ r: number; g: number; b: number }> {
  return locator.evaluate((el) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = 'rgb(128,128,128)'
    ctx.fillRect(0, 0, 1, 1)
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return { r: r!, g: g!, b: b! }
  })
}

/** After a reload or relaunch: opens the group and its only session again. */
export async function reopenSession(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-session-screen]')).toBeVisible()
}
