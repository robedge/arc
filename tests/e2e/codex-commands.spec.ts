// @spec: 007-codex-as-a-second-provider
// @regression
import { expect, test } from '@playwright/test'
import { chooseFromMenu, launchCodexRig, readCodexLog } from './codex-rig'
import type { CodexRig } from './codex-rig'
import { commandMenu, commandOption, composer, sendMessage } from './commands-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 007 section 2.5: the user's Codex skills and saved prompts in the `/` list. The fake Codex lists the skill; the
 * prompt is a file under the temporary CODEX_HOME. No model call is made.
 */

let rig: CodexRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const PROMPT = `---\ndescription: Review a change\nargument-hint: <what>\n---\nReview this change carefully: $ARGUMENTS\n`

async function setup(options: { codex?: Record<string, string>; installed?: boolean } = {}) {
  const r = await launchCodexRig({
    scenario: 'cx-cmd',
    codexScenario: 'cx-cmd',
    repos: [{ name: 'api' }],
    codexInstalled: options.installed ?? true,
    codex: {
      FAKE_CODEX_SKILLS: JSON.stringify(['publish-release']),
      ...options.codex
    },
    homeFiles: () => ({ '.codex/prompts/review.md': PROMPT })
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: 'Review the retry change', mode: 'Autonomous' })
  await expect(r.page.getByText('Ready for a command.').first()).toBeVisible()
  return r
}

test('2.5: typing /pub lists /publish-release and /rev lists /review, each marked Codex', async () => {
  const r = await setup()
  const { page } = r
  await composer(page).fill('/pub')
  const skill = commandOption(page, 'publish-release')
  await expect(skill).toBeVisible()
  await expect(skill.locator('[data-badge]').first()).toHaveText('Codex')

  await composer(page).fill('/rev')
  const prompt = commandOption(page, 'review')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('Review a change')
  await expect(prompt.locator('[data-badge]').first()).toHaveText('Codex')
})

test('2.5: with Codex not installed, Codex skills and prompts are not listed', async () => {
  const r = await setup({ installed: false })
  const { page } = r
  await composer(page).fill('/pub')
  await expect(commandMenu(page)).toBeVisible()
  await expect(commandOption(page, 'publish-release')).toHaveCount(0)
  await composer(page).fill('/rev')
  await expect(commandOption(page, 'review')).toHaveCount(0)
})

test('2.5: with Workers on Claude, running a Codex prompt starts a Codex worker labelled with the prompt', async () => {
  const r = await setup()
  const { page } = r
  await chooseFromMenu(page, 'Worker model', 'Claude')
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Claude/i)

  await sendMessage(page, '/review the retry change')
  const card = workerCard(page, 'W1 · /review')
  await expect(card.locator('[data-worker-model]')).toHaveText('Codex · fake-deep')
  await expect(
    eventLog(page).filter({ hasText: /started W1 · \/review · Codex · fake-deep/ })
  ).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  // The worker's first message is the prompt, expanded by Arc with the user's arguments.
  expect(
    readCodexLog(r).some((l) =>
      JSON.stringify(l['recv'] ?? '').includes('Review this change carefully: the retry change')
    )
  ).toBe(true)
})
