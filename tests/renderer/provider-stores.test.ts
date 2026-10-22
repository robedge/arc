import { beforeEach, expect, it } from 'vitest'
import { render, screen } from '@testing-library/svelte'
import BypassWarning from '../../src/renderer/src/lib/components/settings/BypassWarning.svelte'
import { models } from '../../src/renderer/src/lib/stores/models.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { PROVIDER_IDS } from '../../src/shared/types/provider'
import { mockHarness } from './helpers'

beforeEach(() => {
  providers.reset()
  models.reset()
})

it('busy has an entry for every provider', () => {
  expect(Object.keys(providers.busy).sort()).toEqual([...PROVIDER_IDS].sort())
  expect(providers.busy.cursor).toBe(false)
})

it('a models answer with no cursor key leaves Cursor with no models', async () => {
  mockHarness(
    () =>
      ({
        ok: true,
        data: {
          claude: [{ ref: { provider: 'claude', model: 'opus' }, label: 'Opus' }],
          codex: []
        }
      }) as never
  )
  await models.load()
  expect(models.lists.claude).toHaveLength(1)
  expect(models.lists.cursor).toEqual([])
})

it('keeps the cursor list main sends', async () => {
  const cursor = [{ ref: { provider: 'cursor', model: 'auto' }, label: 'Auto' }]
  mockHarness(() => ({ ok: true, data: { claude: [], codex: [], cursor } }) as never)
  await models.load()
  expect(models.lists.cursor).toEqual(cursor)
})

it('a bypass report with only a cursor block reaches the store and shows the Cursor section', async () => {
  const cursor = { allowEntries: ['Shell(git)'], hookEvents: ['beforeShellExecution'] }
  mockHarness(
    () =>
      ({
        ok: true,
        data: { claudeHookEvents: [], codexAllowPrefixes: [], codexRulesCovered: 0, cursor }
      }) as never
  )
  await providers.loadBypass()
  expect(providers.bypass?.cursor).toEqual(cursor)
  render(BypassWarning, { props: { report: providers.bypass, onrefresh: () => {} } })
  expect(screen.getByLabelText('Cursor allow entries')).toBeTruthy()
})

it('a bypass report whose cursor block lacks its arrays loads with empty lists and no rejection', async () => {
  mockHarness(
    () =>
      ({
        ok: true,
        data: {
          claudeHookEvents: [],
          codexAllowPrefixes: [],
          codexRulesCovered: 0,
          cursor: { approvalMode: 'unrestricted' }
        }
      }) as never
  )
  await expect(providers.loadBypass()).resolves.toBeUndefined()
  expect(providers.bypass?.cursor).toEqual({
    allowEntries: [],
    approvalMode: 'unrestricted',
    hookEvents: []
  })
})
