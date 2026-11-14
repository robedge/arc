// @spec: 011-learning-loop
// @regression
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { launchCodexRig, readCodexLog, setDefault } from './codex-rig'
import { expectNoneWaiting } from './attention-rig'
import type { CodexRig } from './codex-rig'
import {
  cursorMcpResults,
  cursorPermissionAnswers,
  cursorPrompts,
  launchCursorRig
} from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, startSession } from './sessions-rig'

/**
 * Spec 011 slice 8: a Codex brain and a Cursor brain call `suggest_knowledge_update` through Arc's bridge, and the
 * chip and the dialog show the suggestion, as for the Claude brain (knowledge-suggestions.spec.ts). Fake CLIs only.
 * The tool is not a long-running one and no approval prompt may stand in its way: for Codex that is
 * `default_tools_approval_mode: approve` plus `enabled_tools`, for Cursor the allowance of every `arc` tool.
 */

let rig: CodexRig | CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const chip = (page: Page) =>
  page.getByRole('button', { name: /Knowledge suggestions, \d+ waiting/ })
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Knowledge suggestions' })

const ORDERS_TEXT =
  'The orders table is partitioned by month.\nQueries should filter on created_at to hit one partition.'

/** The chip reads "Suggestions 1" and the dialog lists the card with its title, destination and text. */
async function expectOneSuggestion(page: Page): Promise<void> {
  await expect(chip(page)).toBeVisible({ timeout: 30_000 })
  await expect(chip(page)).toContainText('Suggestions')
  await expect(chip(page).locator('[data-count]')).toHaveText('1')
  await chip(page).click()
  await expect(dialog(page)).toBeVisible()
  const card = dialog(page).getByRole('article', {
    name: 'Knowledge suggestion: Orders table is partitioned by month'
  })
  await expect(card).toHaveAttribute('data-kind', 'new')
  await expect(card).toContainText('Notes')
  await expect(card).toContainText('New note: Orders partitioning')
  await expect(card).toContainText('The schema dump in the orders migration')
  await expect(card.locator('pre')).toHaveText(ORDERS_TEXT)
  // It never needed the user: nothing is waiting under Needs attention.
  await expectNoneWaiting(page)
}

test('Codex brain: it calls suggest_knowledge_update, which is enabled for the brain and not asked about, and the chip reads "Suggestions 1"', async () => {
  const r = await launchCodexRig({
    scenario: 'cx-spawn',
    codexScenario: 'ks-suggest',
    repos: [{ name: 'api' }]
  })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Fake Deep')
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(
    /Brain · Codex Fake Deep/i
  )
  await expect(page.locator('[data-brain-model]')).toHaveText('Codex · fake-deep')
  await expect(page.getByText('The orders table is partitioned by month.').first()).toBeVisible({
    timeout: 20_000
  })

  await expectOneSuggestion(page)

  // The fake's log: the bridge call succeeded.
  const results = readCodexLog(r).flatMap((l) => {
    const m = l['mcpResult'] as { tool: string; isError: boolean; text: string } | undefined
    return m ? [m] : []
  })
  expect(results.filter((m) => m.tool === 'suggest_knowledge_update')).toEqual([
    expect.objectContaining({ isError: false, text: expect.stringContaining('"ok":true') })
  ])
  // No approval round trip for the call (an MCP approval would come as an elicitation request).
  const sent = readCodexLog(r).flatMap((l) => {
    const m = l['send'] as { method?: string } | undefined
    return m?.method ? [m.method] : []
  })
  expect(sent.filter((m) => m.includes('requestApproval') || m.includes('elicitation'))).toEqual([])

  // The brain's thread: the tool is enabled on the `arc` server and the instructions name it without a prefix.
  const brain = readCodexLog(r).flatMap((l) => {
    const t = l['thread'] as
      | {
          role?: string
          config?: { mcp_servers?: { arc?: { enabled_tools?: string[] } } }
          developerInstructions?: string
        }
      | undefined
    return t?.role === 'brain' ? [t] : []
  })
  expect(brain).toHaveLength(1)
  expect(brain[0]!.config?.mcp_servers?.arc?.enabled_tools).toContain('suggest_knowledge_update')
  expect(brain[0]!.developerInstructions).toContain('Knowledge suggestions: when you finish')
  expect(brain[0]!.developerInstructions).toMatch(/call suggest_knowledge_update \(up to 5/)
  expect(brain[0]!.developerInstructions).not.toContain('mcp__arc__')
})

test('Cursor brain: it calls suggest_knowledge_update through the arc server without an approval, and the chip reads "Suggestions 1"', async () => {
  const r = await launchCursorRig({ cursorScenario: 'ks-suggest', repos: [{ name: 'api' }] })
  rig = r
  const { page, repos } = r
  await createGroupWithProjects(r, 'Storefront', [repos['api']!])
  await setDefault(page, 'Default brain', 'Auto (default)')
  await startSession(page, { request: 'What do you know about orders?', mode: 'Autonomous' })
  await expect(page.getByRole('button', { name: 'Brain model' })).toHaveText(/Brain · Cursor Auto/)
  await expect(page.getByText('The orders table is partitioned by month.').first()).toBeVisible({
    timeout: 20_000
  })

  await expectOneSuggestion(page)

  // The fake's log: the bridge call succeeded, and no permission request was raised for it.
  expect(cursorMcpResults(r).filter((m) => m.tool === 'suggest_knowledge_update')).toEqual([
    expect.objectContaining({ isError: false, text: expect.stringContaining('"ok":true') })
  ])

  expect(cursorPermissionAnswers(r)).toEqual([])

  // The instructions in front of the brain's first prompt name the tool without a prefix.
  const first = cursorPrompts(r).find((p) => p.role === 'brain')
  expect(first?.text).toContain('<arc-instructions>')
  expect(first?.text).toContain('Knowledge suggestions: when you finish')
  expect(first?.text).toMatch(/call suggest_knowledge_update \(up to 5/)
  expect(first?.text).not.toContain('mcp__arc__')
})
