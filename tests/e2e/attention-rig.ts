// The one place the e2e specs learn what the "Needs attention" dock and its request panels look like.
// Requests wait in a dock above the message box on the Brain tab; there is no header button and no dialog.
// The markup inside a panel is the generic surface renderer's; a change to it should only touch this file.
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/** The kinds of request the dock shows. */
export type RequestKind = 'permission' | 'question' | 'branch'

/** The dock: only present while requests wait, and only on the Brain tab. */
export const dock = (page: Page): Locator => page.locator('[data-attention-dock]')

/** The dock heading, "Needs attention · N". */
export const dockHeading = (page: Page): Locator =>
  dock(page).getByRole('heading', { name: /^Needs attention · \d+$/ })

/** The dock shows exactly `count` waiting requests. */
export async function expectWaiting(
  page: Page,
  count: number,
  options: { timeout?: number } = {}
): Promise<void> {
  await expect(dock(page)).toHaveCount(1, options)
  await expect(dockHeading(page)).toHaveAccessibleName(`Needs attention · ${count}`, options)
  await expect(dock(page).locator('article[data-kind]')).toHaveCount(count, options)
}

/** Nothing waits: the dock is gone. */
export async function expectNoneWaiting(page: Page): Promise<void> {
  await expect(dock(page)).toHaveCount(0)
}

/** Nothing covers the session: no dialog of any kind is open. */
export async function expectNoDialog(page: Page): Promise<void> {
  await expect(page.getByRole('dialog')).toHaveCount(0)
}

/** Every request of one kind in the dock, optionally only those whose text contains `text`. */
export function requests(page: Page, kind: RequestKind, text?: string | RegExp): Locator {
  const all = dock(page).locator(`article[data-kind="${kind}"]`)
  return text === undefined ? all : all.filter({ hasText: text })
}

/** The first request of a kind (the oldest one waits first), optionally filtered by text. */
export const request = (page: Page, kind: RequestKind, text?: string | RegExp): Locator =>
  requests(page, kind, text).first()

/** A permission request filtered by who asked, for example `permissionFrom(page, 'Brain')`. */
export const permissionFrom = (page: Page, from: string | RegExp): Locator =>
  dock(page).getByRole('article', { name: new RegExp(`^Permission request from ${source(from)}`) })

function source(from: string | RegExp): string {
  return typeof from === 'string' ? from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : from.source
}

/** The command (or other action text) a permission asks to run: the first code block of its panel. */
export const permissionAction = (panel: Locator): Locator => panel.locator('pre[data-code]').first()

/** The text of the command of the oldest permission request. */
export async function pendingAction(page: Page): Promise<string> {
  const action = await permissionAction(request(page, 'permission')).innerText()
  return action.trim()
}

// Permission actions.
export const approve = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Approve', exact: true }).click()
export const deny = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Deny', exact: true }).click()
export const alwaysAllow = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Always allow this in this session' }).click()

// Question actions.
/** Types a plain answer and sends it. */
export async function answerQuestion(panel: Locator, text: string): Promise<void> {
  await panel.getByLabel('Your answer').fill(text)
  await panel.getByRole('button', { name: 'Send' }).click()
}
/** A choice button of a question with options, by the start of its label. */
export const choice = (panel: Locator, label: string | RegExp): Locator =>
  panel.getByRole('button', {
    name: typeof label === 'string' ? new RegExp(`^${source(label)}`) : label
  })
export const otherBox = (panel: Locator): Locator => panel.getByLabel('Other')
export const submitChoices = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Submit' }).click()
export const decline = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Decline' }).click()

// Unsaved-changes actions.
export const branchChoice = (panel: Locator, label: string): Locator =>
  panel.getByRole('radio', { name: label })
export const continueBranch = (panel: Locator): Promise<void> =>
  panel.getByRole('button', { name: 'Continue' }).click()
/** Picks one way to handle the changes and continues. */
export async function chooseForBranch(panel: Locator, label: string): Promise<void> {
  await branchChoice(panel, label).check()
  await continueBranch(panel)
}
