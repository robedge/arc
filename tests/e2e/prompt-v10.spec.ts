// @spec: 014-inline-needs-attention
// @regression
import { expect, test } from '@playwright/test'
import {
  createGroupWithProjects,
  launchRig,
  readFakeLog,
  sendToBrain,
  startSession
} from './sessions-rig'
import type { Rig } from './sessions-rig'
import { query, sql } from './usage-rig'

/**
 * Spec 014 slice 8: a session created under brain prompt version 9 is told about show_surface once, with the first
 * message after Arc resumes it, and not again with the next one. The stored version is set in Arc's own database
 * while Arc is closed, the way an older install would have left it.
 */

const NOTE = '[Arc] Updated instructions: you can show the user an interactive panel'
const REPLY = 'I remember the earlier conversation.'

let rig: Rig | undefined
test.afterEach(async () => {
  await rig?.dispose()
  rig = undefined
})

function stdinTexts(r: Rig): string[] {
  return readFakeLog(r)
    .filter((l) => 'stdin' in l)
    .map((l) => JSON.stringify(l['stdin']))
}

test('a resumed version 9 session gets the panel note once, with its first message', async () => {
  rig = await launchRig({ scenario: 'resume-after', repos: [{ name: 'api' }] })
  await createGroupWithProjects(rig, 'Storefront', [rig.repos['api']!])
  await startSession(rig.page, { request: 'Hello brain', mode: 'Autonomous' })
  await expect(rig.page.getByText(REPLY)).toHaveCount(1)
  expect(query(rig, 'select brain_prompt_version as v from sessions')[0]?.['v']).toBe(10)
  expect(stdinTexts(rig).filter((t) => t.includes(NOTE))).toHaveLength(0)

  sql(rig, [{ sql: 'update sessions set brain_prompt_version = 9' }])
  await rig.relaunch({ scenario: 'resume-after' })
  const page = rig.page
  await page
    .getByRole('navigation', { name: 'Groups' })
    .getByRole('button', { name: 'Storefront' })
    .click()
  await page.locator('[data-session-row]').first().click()
  await expect(page.locator('[data-message-role="user"]').first()).toHaveText('Hello brain')

  await sendToBrain(page, 'First after resume')
  await expect(page.getByText(REPLY)).toHaveCount(2)
  await sendToBrain(page, 'Second after resume')
  await expect(page.getByText(REPLY)).toHaveCount(3)

  const sent = stdinTexts(rig)
  expect(sent.filter((t) => t.includes(NOTE))).toHaveLength(1)
  expect(sent.find((t) => t.includes(NOTE))).toContain('First after resume')
  expect(sent.find((t) => t.includes('Second after resume'))).not.toContain(NOTE)
  expect(query(rig, 'select brain_prompt_version as v from sessions')[0]?.['v']).toBe(10)
})
