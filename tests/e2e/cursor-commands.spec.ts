// @spec: 010-cursor-as-a-third-provider
// @regression
import { expect, test } from '@playwright/test'
import { chooseFromMenu, openSettings, closeSettings, providerRow } from './codex-rig'
import { commandMenu, commandOption, composer } from './commands-rig'
import { cursorPrompts, launchCursorRig } from './cursor-rig'
import type { CursorRig } from './cursor-rig'
import { createGroupWithProjects, eventLog, startSession, workerCard } from './sessions-rig'

/**
 * Spec 010 section 2.8: the user's Cursor commands in the `/` list. The command is a file under the temporary
 * HOME's `~/.cursor/commands`, and the fake Cursor's probe lists it in its `available_commands_update`. The brain is
 * the fake Claude CLI and the command worker the fake Cursor in `acp` mode; no model call is made.
 */

let rig: CursorRig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

const REVIEW = `---\ndescription: Review a change\nargument-hint: <what>\n---\nReview this change carefully: $ARGUMENTS\n`

async function setup(options: { cursorScenario: string; request: string; ready: string }) {
  const r = await launchCursorRig({
    cursorScenario: options.cursorScenario,
    repos: [{ name: 'api' }],
    cursor: {
      FAKE_CURSOR_COMMANDS: JSON.stringify([
        { name: 'review', description: 'Review a change (user)' }
      ])
    },
    homeFiles: () => ({ '.cursor/commands/review.md': REVIEW })
  })
  rig = r
  await createGroupWithProjects(r, 'Storefront', [r.repos['api']!])
  await startSession(r.page, { request: options.request, mode: 'Autonomous' })
  await expect(r.page.getByText(options.ready).first()).toBeVisible()
  return r
}

/** The text of a prompt after Arc's `<arc-instructions>` block (ACP has no system prompt). */
const afterInstructions = (text: string): string =>
  text.replace(/^<arc-instructions>[\s\S]*?<\/arc-instructions>\n\n/, '')

/** The first worker prompt: the review.md body (front matter stripped) with the arguments, not a bare `/review`. */
function expectExpandedReview(text: string): void {
  const message = afterInstructions(text)
  expect(message).toBe(
    'Running the Cursor command /review.\n\nReview this change carefully: the retry change\n'
  )
  expect(message).not.toMatch(/^\/review/)
  expect(message).not.toContain('description: Review a change')
}

/** The prompts Arc sent to Cursor worker agents (not the model probe, which sends none). */
const workerPrompts = (r: CursorRig) => cursorPrompts(r).filter((p) => p.role === 'worker')

test('2.8: typing /rev lists /review marked Cursor', async () => {
  const r = await setup({
    cursorScenario: 'cc-run',
    request: 'Review the retry change',
    ready: 'Ready for a command.'
  })
  const { page } = r
  await composer(page).fill('/rev')
  const option = commandOption(page, 'review')
  await expect(option).toBeVisible()
  await expect(option).toContainText('Review a change')
  await expect(option.locator('[data-badge]').first()).toHaveText('Cursor')
})

test('2.8: with Workers on Claude, running /review starts a Cursor worker labelled with it', async () => {
  const r = await setup({
    cursorScenario: 'cc-run',
    request: 'Review the retry change',
    ready: 'Ready for a command.'
  })
  const { page } = r
  await chooseFromMenu(page, 'Worker model', 'Claude')
  await expect(page.getByRole('button', { name: 'Worker model' })).toHaveText(/Workers · Claude/i)

  // Pick /review from the list (Enter fills the box), add the arguments and send.
  await composer(page).fill('/rev')
  await expect(commandOption(page, 'review')).toHaveAttribute('aria-selected', 'true')
  await composer(page).press('Enter')
  await expect(composer(page)).toHaveValue('/review ')
  await composer(page).pressSequentially('the retry change')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(composer(page)).toHaveValue('')

  const card = workerCard(page, 'W1 · /review')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(eventLog(page).filter({ hasText: /started W1 · \/review · Cursor/ })).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })

  // Arc expands the command file itself: the first prompt is review.md's body with the arguments applied,
  // after the instructions block, and never starts with a bare slash command.
  const prompts = workerPrompts(r)
  expect(prompts.length).toBeGreaterThanOrEqual(1)
  expectExpandedReview(prompts[0]!.text)
})

test('2.8: with Cursor signed out (after Check again), typing / lists no Cursor commands', async () => {
  const r = await setup({
    cursorScenario: 'cc-run',
    request: 'Review the retry change',
    ready: 'Ready for a command.'
  })
  const { page } = r
  // Listed while signed in.
  await composer(page).fill('/rev')
  await expect(commandOption(page, 'review')).toBeVisible()
  await composer(page).press('Escape')
  await composer(page).fill('')

  r.setCursor({ FAKE_CURSOR_AUTH: 'signed_out' })
  await openSettings(page)
  await providerRow(page, 'cursor').getByRole('button', { name: 'Check Cursor again' }).click()
  await expect(providerRow(page, 'cursor').locator('[data-provider-status]')).toHaveText(
    'Cursor · not signed in'
  )
  await closeSettings(page)

  await composer(page).fill('/')
  await expect(commandMenu(page)).toBeVisible()
  await expect(
    commandMenu(page)
      .getByRole('option')
      .locator('[data-badge]')
      .filter({ hasText: /^Cursor$/ })
  ).toHaveCount(0)
  await expect(commandOption(page, 'review')).toHaveCount(0)
  await composer(page).fill('/rev')
  await expect(commandOption(page, 'review')).toHaveCount(0)
})

test('2.8: an Autonomous brain that picks the Cursor command starts a Cursor worker labelled with it', async () => {
  const r = await setup({
    cursorScenario: 'cc-auto',
    request: 'Please review the retry change',
    ready: 'Your Cursor command review fits this'
  })
  const { page } = r
  const card = workerCard(page, 'W1 · /review')
  await expect(card.locator('[data-worker-model]')).toHaveText(/^Cursor · /)
  await expect(eventLog(page).filter({ hasText: /started W1 · \/review · Cursor/ })).toHaveCount(1)
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 30_000 })
  const prompts = workerPrompts(r)
  expect(prompts.length).toBeGreaterThanOrEqual(1)
  expectExpandedReview(prompts[0]!.text)
})
