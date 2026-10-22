// @spec: 003-sessions-brain-and-workers
// @regression
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { createGroupWithProjects, git, launchRig, startSession } from './sessions-rig'
import type { Rig } from './sessions-rig'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

function branchOf(path: string): string {
  return git(path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
}

test('2.1 + 2.2: first tab, empty request, dirty repo dialog, read-only project, branch header, rename, delete', async () => {
  rig = await launchRig({
    scenario: 'titled-fix-order-sync.jsonl',
    repos: [
      { name: 'api', kind: 'clean' },
      { name: 'web', kind: 'dirty' },
      { name: 'docs', kind: 'plain' }
    ]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!, repos['web']!, repos['docs']!])

  // The Sessions tab is first and already open.
  const tabs = page.getByRole('tablist', { name: 'Sections' }).getByRole('tab')
  await expect(tabs.first()).toHaveText('Sessions')
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true')

  // Empty request: red message under the box, no session.
  await page.getByRole('button', { name: 'New Session' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Start' }).click()
  await expect(dialog.getByText('Enter a request for the brain.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('[data-session-row]')).toHaveCount(0)

  // The web repository has unsaved changes: the dialog names it and offers the four choices.
  await startSession(page, { request: 'Why is the orders report slow?' })
  const dirty = page.getByRole('dialog', { name: 'Unsaved changes' })
  await expect(dirty).toBeVisible()
  await expect(dirty.getByText('web', { exact: true })).toBeVisible()
  await expect(dirty.getByText('Set aside')).toBeVisible()
  await expect(dirty.getByText('Commit them first')).toBeVisible()
  await expect(dirty.getByText('Bring them along')).toBeVisible()
  await expect(dirty.getByRole('button', { name: 'Cancel' })).toBeVisible()

  // Cancel: nothing is created, every repository keeps its branch and the changes stay.
  await dirty.getByRole('button', { name: 'Cancel' }).click()
  await expect(dirty).toHaveCount(0)
  expect(branchOf(repos['api']!)).toBe('dev')
  expect(branchOf(repos['web']!)).toBe('dev')
  expect(readFileSync(join(repos['web']!, 'README.md'), 'utf8')).toBe('hello\nchanged\n')
  expect(readFileSync(join(repos['web']!, 'untracked.txt'), 'utf8')).toBe('new\n')

  // The New Session dialog is back with the request kept; no session exists yet.
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeVisible()
  await page
    .getByRole('dialog', { name: 'New session' })
    .getByRole('button', { name: 'Start' })
    .click()
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByLabel('Bring them along').check()
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Continue' })
    .click()

  // The session screen opens with the request as the first message.
  const conversation = page.getByRole('log', { name: 'Conversation' })
  await expect(conversation).toBeVisible()
  await expect(conversation.locator('[data-message-role="user"]').first()).toHaveText(
    'Why is the orders report slow?'
  )

  // The brain replied: the session has a short name instead of "New session".
  await expect(page.locator('[data-session-name]')).toHaveText('Fix order sync')

  // Header: branch chip with its base, read-only project.
  const chips = page.getByRole('list', { name: 'Session branches' })
  await expect(chips.locator('[data-branch-chip="branch"]').first()).toContainText(
    'arc/fix-order-sync ← dev'
  )
  await expect(chips.locator('[data-branch-chip="read-only"]')).toContainText('Read only')
  await expect(chips.locator('[data-branch-chip="read-only"]')).toContainText('docs')
  // The user's own folders are on the session branch.
  expect(branchOf(repos['api']!)).toBe('arc/fix-order-sync')
  expect(branchOf(repos['web']!)).toBe('arc/fix-order-sync')

  // Rename shows in the header and the list.
  await page.getByRole('button', { name: 'Rename session' }).click()
  await page.getByLabel('Session name').fill('Orders report')
  await page.getByLabel('Session name').press('Enter')
  await expect(page.locator('[data-session-name]')).toHaveText('Orders report')
  await page.getByRole('button', { name: 'Sessions', exact: true }).click()
  const rows = page.locator('[data-session-row]')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Orders report')

  // Delete: gone from the list, the session branches stay.
  await page.getByRole('button', { name: 'Session options' }).click()
  await page.getByRole('menuitem', { name: 'Delete Session' }).click()
  await expect(page.getByRole('dialog', { name: 'Delete Session' })).toContainText(
    'Its branches are kept in your repositories'
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(rows).toHaveCount(0)
  const branches = execFileSync('git', ['branch', '--list'], {
    cwd: repos['api']!,
    encoding: 'utf8'
  })
  expect(branches).toContain('arc/fix-order-sync')
})

test('2.2: a repository without a dev branch starts the session branch from its main branch', async () => {
  rig = await launchRig({
    scenario: 'titled-fix-order-sync.jsonl',
    repos: [{ name: 'api', kind: 'no-dev' }]
  })
  const { page, repos } = rig
  await createGroupWithProjects(rig, 'Storefront', [repos['api']!])
  await startSession(page, { request: 'Why is the orders report slow?' })

  await expect(page.locator('[data-session-name]')).toHaveText('Fix order sync')
  await expect(
    page.getByRole('list', { name: 'Session branches' }).locator('[data-branch-chip="branch"]')
  ).toContainText('arc/fix-order-sync ← main')
  expect(branchOf(repos['api']!)).toBe('arc/fix-order-sync')
})
