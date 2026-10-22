// @spec: 005-commands-and-skills-in-sessions
// @regression
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  startSession,
  workerCard
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import { makeFakeHome, saveRepoCommand, sendMessage, sessionStarts, flag } from './commands-rig'
import type { FakeHome } from './commands-rig'
import { fileRow, openReview, reviewButton } from './review-rig'

// One Arc run per test, so no test depends on another.
test.setTimeout(120_000)

let rig: Rig | undefined
let home: FakeHome | undefined
test.afterEach(async () => {
  await rig?.dispose()
  await home?.dispose()
  rig = undefined
  home = undefined
})

const badge = (page: Page) => page.getByRole('button', { name: /Needs attention, \d+ waiting/ })
const attentionDialog = (page: Page) => page.getByRole('dialog', { name: /Needs attention/ })

/** A group over the named repositories, each saving `/awos:spec`, and a session in the given mode. */
async function setup(
  scenario: string,
  options: { repos?: string[]; mode: 'Autonomous' | 'Plan-first'; request?: string }
): Promise<Rig> {
  const names = options.repos ?? ['api']
  home = await makeFakeHome()
  const r = await launchRig({
    scenario,
    repos: names.map((name) => ({ name })),
    env: home.env
  })
  rig = r
  for (const name of names) {
    saveRepoCommand(r.repos[name]!, 'awos/spec', 'Creates the Functional Spec')
  }
  await createGroupWithProjects(
    r,
    'Storefront',
    names.map((name) => r.repos[name]!)
  )
  await startSession(r.page, {
    request: options.request ?? 'Plan retry settings',
    mode: options.mode
  })
  await expect(r.page.locator('[data-session-screen]')).toBeVisible()
  return r
}

/** The text of every user message the fake CLI received on stdin, in order. */
function userTexts(r: Pick<Rig, 'logPath'>): string[] {
  const texts: string[] = []
  for (const record of readFakeLog(r)) {
    const stdin = record['stdin']
    if (typeof stdin !== 'object' || stdin === null) continue
    const message = (stdin as { type?: string; message?: { content?: unknown } }).message
    if ((stdin as { type?: string }).type !== 'user' || !message) continue
    const content = message.content
    if (typeof content === 'string') texts.push(content)
    else if (Array.isArray(content)) {
      for (const part of content as { type?: string; text?: string }[]) {
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
    }
  }
  return texts
}

function brainPrompt(r: Pick<Rig, 'logPath'>): string {
  const brain = sessionStarts(readFakeLog(r)).find((argv) =>
    (flag(argv, '--append-system-prompt') ?? '').includes('arc-role:brain')
  )
  return flag(brain ?? [], '--append-system-prompt') ?? ''
}

test('2.2: a command in Autonomous mode starts a labelled worker in api and its files reach change review', async () => {
  const r = await setup('cmd-auto', { mode: 'Autonomous' })
  const { page } = r
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(page, '/awos:spec for retry settings')

  // The conversation shows the message with the command highlighted.
  await expect(page.locator('[data-command]')).toHaveText('/awos:spec')
  const card = workerCard(page, 'W1 · /awos:spec')
  await expect(card).toHaveAttribute('data-worker-card', 'merged', { timeout: 60_000 })
  // The worker's first message is exactly the command text, which the CLI expands.
  expect(userTexts(r)).toContain('/awos:spec for retry settings')

  await expect(reviewButton(page)).toHaveText('Review changes · 1')
  await openReview(page)
  await expect(fileRow(page, 'api', 'specs/retry-settings.md')).toBeVisible()
})

test('2.2: in Plan-first mode the plan lists the command worker and nothing starts until Approve', async () => {
  const r = await setup('cmd-plan', { mode: 'Plan-first' })
  const { page } = r
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(page, '/awos:spec for retry settings')

  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan).toBeVisible()
  await expect(plan.locator('[data-plan-worker]')).toHaveCount(1)
  await expect(plan.locator('[data-plan-command]')).toContainText('/awos:spec')
  // The brain's attempt to start the worker before approval was refused: no worker exists yet.
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
  expect(userTexts(r).filter((t) => t === '/awos:spec for retry settings')).toHaveLength(0)

  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(workerCard(page, 'W1 · /awos:spec')).toBeVisible()
  await expect(workerCard(page, 'W1 · /awos:spec')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 60_000
  })
})

test('2.2: with two repositories and none named, the brain asks which one and offers both names', async () => {
  const r = await setup('cmd-ask', { mode: 'Autonomous', repos: ['api', 'web'] })
  const { page } = r
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(page, '/awos:spec for retry settings')

  // The brain is told to pick the repository or ask with the names as choices.
  await expect(badge(page)).toHaveCount(1)
  expect(userTexts(r).join('\n')).toContain(
    'if it is unclear, call ask_user with the repository names as choices'
  )
  await badge(page).click()
  const dialog = attentionDialog(page)
  await expect(dialog.getByText('Which repository should /awos:spec run in?')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'api', exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'web', exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'web', exact: true }).click()
  await dialog.getByRole('button', { name: 'Submit' }).click()

  await expect(workerCard(page, 'W1 · /awos:spec')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 60_000
  })
  await openReview(page)
  await expect(fileRow(page, 'web', 'specs/retry-settings.md')).toBeVisible()
})

test('2.2: a command that only answers leaves no changes and its answer reaches the brain reply', async () => {
  const r = await setup('cmd-answer', { mode: 'Autonomous' })
  const { page } = r
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(page, '/awos:spec what are the retry defaults?')

  await expect(workerCard(page, 'W1 · /awos:spec')).toHaveAttribute(
    'data-worker-card',
    /done|merged/,
    {
      timeout: 60_000
    }
  )
  // The brain's reply is scripted to wait for the worker's answer, so it appears only once Arc relayed it.
  await expect(page.getByText('The command answered: Retries default to 3 attempts.')).toBeVisible({
    timeout: 30_000
  })
  await expect(reviewButton(page)).toHaveAttribute('aria-disabled', 'true')
})

test('2.2: helper agents of a command show in its worker terminal and get no worker cards', async () => {
  const r = await setup('cmd-helpers', { mode: 'Autonomous' })
  const { page } = r
  await expect(page.getByText('Ready for a command.').first()).toBeVisible()
  await sendMessage(page, '/awos:spec with helpers')

  const card = workerCard(page, 'W1 · /awos:spec')
  await expect(card.locator('[data-worker-helpers]')).toHaveText('2 helpers')
  await card.getByRole('button').first().click()
  const log = page.getByRole('log', { name: 'W1 · /awos:spec output' })
  await expect(log).toContainText('helper (Check types)')
  await expect(log).toContainText('helper (Run the linter)')
  await expect(page.locator('[data-worker-card]')).toHaveCount(1)

  // The helpers end: the chip clears, the worker finishes, and there is still one card.
  writeFileSync(join(r.repos['api']!, '.git', 'arc-gate'), 'go\n')
  await expect(card.locator('[data-worker-helpers]')).toHaveCount(0, { timeout: 30_000 })
  await expect(card).toHaveAttribute('data-worker-card', /done|merged/, { timeout: 60_000 })
  await expect(log).toContainText('helper (Check types): finished')
  await expect(page.locator('[data-worker-card]')).toHaveCount(1)
})

test('2.3: asked in plain words in Plan-first mode, the brain lists /awos:spec in the plan and nothing starts', async () => {
  const r = await setup('cmd-brain-plan', { mode: 'Plan-first' })
  const { page } = r
  await expect(page.getByText('Tell me what to do.').first()).toBeVisible()
  // The brain was given the user's commands when it launched.
  expect(brainPrompt(r)).toContain('Commands available:')
  expect(brainPrompt(r)).toContain('/awos:spec')
  await sendMessage(page, 'write a spec for retry settings')

  const plan = page.locator('[data-plan-card="proposed"]')
  await expect(plan.locator('[data-plan-command]')).toContainText('/awos:spec')
  await expect(page.locator('[data-worker-card]')).toHaveCount(0)
  await plan.getByRole('button', { name: 'Approve' }).click()
  await expect(workerCard(page, 'W1 · /awos:spec')).toBeVisible()
})

test('2.3: in Autonomous mode the brain starts the command, names it with a reason, and the card carries its label', async () => {
  const r = await setup('cmd-brain-auto', { mode: 'Autonomous' })
  const { page } = r
  await expect(page.getByText('Tell me what to do.').first()).toBeVisible()
  await sendMessage(page, 'write a spec for retry settings')

  await expect(page.getByText('I started /awos:spec because it writes specs.')).toBeVisible()
  await expect(workerCard(page, 'W1 · /awos:spec')).toBeVisible()
  await expect(workerCard(page, 'W1 · /awos:spec')).toHaveAttribute('data-worker-card', 'merged', {
    timeout: 60_000
  })
})
