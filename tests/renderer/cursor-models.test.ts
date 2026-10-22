import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import BrainCard from '../../src/renderer/src/lib/components/sessions/BrainCard.svelte'
import ProviderTag from '../../src/renderer/src/lib/components/ui/ProviderTag.svelte'
import DefaultPickers from '../../src/renderer/src/lib/components/settings/DefaultPickers.svelte'
import PlanCard from '../../src/renderer/src/lib/components/sessions/PlanCard.svelte'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import {
  brainText,
  cursorEffort,
  cursorGroups,
  resolveCursorEffort,
  workersEntries,
  workersText,
  type PickerEntry
} from '../../src/renderer/src/lib/model-options'
import { models } from '../../src/renderer/src/lib/stores/models.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import type {
  AppSettings,
  ModelInfo,
  ProviderModels,
  ProviderStatus
} from '../../src/shared/types/provider'
import type { SessionHeader as Header, PlanView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const cursor = (
  model: string,
  label: string,
  group: string,
  base: string,
  variant?: string,
  isDefault = false
): ModelInfo => ({
  ref: { provider: 'cursor', model },
  label,
  tier: 'balanced',
  isDefault,
  group,
  base,
  ...(variant !== undefined ? { variant } : {})
})

const grok = (effort: string, fast: boolean): ModelInfo =>
  cursor(
    `grok-4.7[context=256k,reasoning_effort=${effort},fast=${fast}]`,
    `grok-4.7 · ${effort}${fast ? ' · fast' : ''}`,
    'Grok',
    'grok-4.7',
    `context=256k,reasoning_effort=${effort},fast=${fast}`
  )

// Account order: Sonnet first, Auto in the middle, to prove Auto is moved to the front.
const cursorList: ModelInfo[] = [
  cursor('claude-sonnet-5[]', 'claude-sonnet-5', 'Claude', 'claude-sonnet-5'),
  cursor('default[]', 'Auto', 'Cursor', 'Auto', undefined, true),
  grok('low', false),
  grok('low', true),
  grok('high', false),
  grok('high', true),
  cursor('composer-2.5[]', 'composer-2.5', 'Cursor', 'composer-2.5'),
  cursor('gpt-5.2[]', 'gpt-5.2', 'GPT/Codex', 'gpt-5.2')
]

const lists: ProviderModels = {
  claude: [
    { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
    {
      ref: { provider: 'claude', model: 'sonnet' },
      label: 'Sonnet',
      tier: 'balanced',
      isDefault: true
    }
  ],
  codex: [],
  cursor: cursorList
}

const status = (state: ProviderStatus['state']): ProviderStatus => ({
  provider: 'cursor',
  state,
  message: '',
  checkedAt: 1
})

const names = (entries: PickerEntry[]): string[] =>
  entries.map((e) => ('group' in e ? `[${e.group}]` : e.label))

it('cursorGroups collapses variants into base rows, grouped by maker, Auto first', () => {
  const groups = cursorGroups(cursorList)
  expect(groups.map((g) => g.title)).toEqual([
    'Cursor · Composer',
    'Cursor · Claude',
    'Cursor · Grok',
    'Cursor · GPT'
  ])
  expect(groups[0]!.rows.map((r) => r.label)).toEqual(['Auto (default)', 'composer-2.5'])
  expect(groups[2]!.rows.map((r) => r.label)).toEqual(['grok-4.7'])
  expect(groups[2]!.rows[0]!.value).toBe('grok-4.7[context=256k,reasoning_effort=low,fast=false]')
})

it('cursorGroups keeps the current variant as the row value', () => {
  const current = 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
  const row = cursorGroups(cursorList, current)
    .flatMap((g) => g.rows)
    .find((r) => r.base === 'grok-4.7')
  expect(row?.value).toBe(current)
})

it('cursorGroups keeps a pick the account no longer offers, marked unavailable', () => {
  const groups = cursorGroups(cursorList, 'old-model[]')
  const last = groups.at(-1)!
  expect(last.rows.at(-1)).toMatchObject({ value: 'old-model[]', label: 'old-model (unavailable)' })
})

it('cursorEffort lists the offered levels and the Fast toggle; resolve returns a full id', () => {
  const low = 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
  const choice = cursorEffort(cursorList, low)
  expect(choice?.levels.map((l) => l.label)).toEqual(['Low', 'High'])
  expect(choice).toMatchObject({ effort: 'low', fastOffered: true, fast: false })
  expect(resolveCursorEffort(cursorList, low, { effort: 'high' })).toBe(
    'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
  )
  expect(resolveCursorEffort(cursorList, low, { fast: true })).toBe(
    'grok-4.7[context=256k,reasoning_effort=low,fast=true]'
  )
  expect(cursorEffort(cursorList, 'gpt-5.2[]')).toBeNull()
})

it('workersEntries offers Cursor after Codex only when ready or picked', () => {
  const ready = { claude: true, codex: true, cursor: true }
  expect(names(workersEntries(lists, ready, { mode: 'auto' })).slice(0, 4)).toEqual([
    'Auto',
    'Claude',
    'Codex',
    'Cursor'
  ])
  const down = { claude: true, codex: false, cursor: false }
  expect(names(workersEntries(lists, down, { mode: 'auto' }))).toEqual([
    'Auto',
    'Claude',
    '[Claude]'
  ])
  expect(names(workersEntries(lists, down, { mode: 'provider', provider: 'cursor' }))).toContain(
    'Cursor (unavailable)'
  )
})

it('workersText and brainText take a readiness map', () => {
  const pref = {
    mode: 'model',
    model: { provider: 'cursor', model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]' }
  } as const
  const ready = { claude: true, codex: false, cursor: true }
  expect(workersText(pref, lists, ready)).toBe('Workers · Cursor grok-4.7 · high')
  expect(workersText(pref, lists, { ...ready, cursor: false })).toBe(
    'Workers · Cursor grok-4.7 · high (unavailable)'
  )
  expect(workersText({ mode: 'provider', provider: 'codex' }, lists, ready)).toBe(
    'Workers · Codex (unavailable)'
  )
  expect(brainText({ provider: 'claude', model: 'sonnet' }, lists, ready)).toBe('Brain · Sonnet')
})

// ---- components ----

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'N',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  workers: { mode: 'auto' },
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

let saved: AppSettings
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  providers.reset()
  models.reset()
  settings.reset()
  models.lists = lists
  providers.set({ cursor: status('ok') })
  saved = {
    'providers.brain': { provider: 'claude', model: 'sonnet' },
    'providers.workers': { mode: 'auto' },
    'usage.checkClaudePlanOnLaunch': true,
    'agents.loadOff': { brain: [], workers: [] }
  }
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

it('SessionHeader Workers menu shows Cursor groups and commits a full id', async () => {
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Worker model' }))
  const menu = screen.getByRole('menu')
  const composer = within(menu).getByRole('group', { name: 'Cursor · Composer' })
  expect(
    within(composer)
      .getAllByRole('menuitemradio')
      .map((e) => e.textContent!.replace('✓', '').trim())
  ).toEqual(['Auto (default)', 'composer-2.5'])
  const grokGroup = within(menu).getByRole('group', { name: 'Cursor · Grok' })
  await fireEvent.click(within(grokGroup).getByRole('menuitemradio', { name: 'grok-4.7' }))
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    workers: {
      mode: 'model',
      model: {
        provider: 'cursor',
        model: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
      }
    }
  })
})

it('SessionHeader Brain menu offers Cursor groups and commits a full id', async () => {
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  const grokGroup = within(screen.getByRole('menu')).getByRole('group', { name: 'Cursor · Grok' })
  await fireEvent.click(within(grokGroup).getByRole('menuitemradio', { name: 'grok-4.7' }))
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    brainModel: {
      provider: 'cursor',
      model: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
    }
  })
})

it('SessionHeader Brain menu hides Cursor while it is not ready', async () => {
  providers.set({ cursor: status('signed_out') })
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  expect(within(screen.getByRole('menu')).queryByRole('group', { name: /Cursor/ })).toBeNull()
})

it('a Cursor brain reads "Brain · Cursor Auto" with an Effort control, and "(unavailable)" when down', async () => {
  const cursorBrain = {
    ...header,
    brainModel: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]',
    brainRunningOn: { provider: 'cursor', model: 'grok-4.7' }
  } as Header
  render(SessionHeader, { header: cursorBrain, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toBe(
    'Brain · Cursor grok-4.7 · low'
  )
  await fireEvent.change(screen.getByLabelText('Cursor effort for the brain'), {
    target: { value: 'high' }
  })
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    brainModel: {
      provider: 'cursor',
      model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
    }
  })
  cleanup()
  providers.set({ cursor: status('signed_out') })
  render(SessionHeader, { header: cursorBrain, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toBe(
    'Brain · Cursor grok-4.7 · low (unavailable)'
  )
})

it('brainText names a Cursor brain, Auto included, and flags it when Cursor is down', () => {
  const auto = { provider: 'cursor' as const, model: 'default[]' }
  const ready = { claude: true, codex: false, cursor: true }
  expect(brainText(auto, lists, ready)).toBe('Brain · Cursor Auto')
  expect(brainText(auto, lists, { ...ready, cursor: false })).toBe(
    'Brain · Cursor Auto (unavailable)'
  )
})

it('DefaultPickers offers Cursor for the brain, with Effort, and commits a full id', async () => {
  const saves: Partial<AppSettings>[] = []
  saved['providers.brain'] = {
    provider: 'cursor',
    model: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
  }
  render(DefaultPickers, {
    settings: saved,
    models: lists,
    statuses: { cursor: status('ok') },
    onsave: (patch: Partial<AppSettings>) => void saves.push(patch)
  })
  const brain = screen.getByLabelText('Default brain') as HTMLSelectElement
  expect([...brain.querySelectorAll('optgroup')].map((g) => g.label)).toContain('Cursor · Grok')
  await fireEvent.change(screen.getByLabelText('Cursor effort'), { target: { value: 'high' } })
  expect(saves).toEqual([
    {
      'providers.brain': {
        provider: 'cursor',
        model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
      }
    }
  ])
})

it('DefaultPickers keeps a saved Cursor brain, flagged unavailable, while Cursor is down', () => {
  saved['providers.brain'] = { provider: 'cursor', model: 'default[]' }
  render(DefaultPickers, {
    settings: saved,
    models: lists,
    statuses: { cursor: status('signed_out') },
    onsave: () => {}
  })
  const brain = screen.getByLabelText('Default brain') as HTMLSelectElement
  expect(brain.value).toBe('cursor:default[]')
  expect(brain.selectedOptions[0]?.textContent).toContain('(unavailable)')
})

it('SessionHeader shows the Effort control for a Cursor pick and commits the resolved id', async () => {
  const picked: Header = {
    ...header,
    workers: {
      mode: 'model',
      model: {
        provider: 'cursor',
        model: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]'
      }
    }
  }
  render(SessionHeader, { header: picked, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Worker model' }).textContent).toBe(
    'Workers · Cursor grok-4.7 · low'
  )
  await fireEvent.change(screen.getByLabelText('Cursor effort'), { target: { value: 'high' } })
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    workers: {
      mode: 'model',
      model: {
        provider: 'cursor',
        model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
      }
    }
  })
})

it('HeaderMenu supports Home, End and type-ahead, and Escape returns focus to the trigger', async () => {
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  const trigger = screen.getByRole('button', { name: 'Worker model' })
  await fireEvent.click(trigger)
  const menu = screen.getByRole('menu')
  const items = within(menu).getAllByRole('menuitemradio')
  await fireEvent.keyDown(menu, { key: 'End' })
  expect(document.activeElement).toBe(items.at(-1))
  await fireEvent.keyDown(menu, { key: 'Home' })
  expect(document.activeElement).toBe(items[0])
  await fireEvent.keyDown(menu, { key: 'g' })
  expect(document.activeElement?.textContent).toContain('grok-4.7')
  await fireEvent.keyDown(menu, { key: 'p' })
  expect(document.activeElement?.textContent).toContain('gpt-5.2')
  await fireEvent.keyDown(menu, { key: 'Escape' })
  expect(document.activeElement).toBe(trigger)
})

it('DefaultPickers groups Cursor models in optgroups and commits the Effort choice', async () => {
  const onsave = (): void => {}
  const saves: Partial<AppSettings>[] = []
  saved['providers.workers'] = {
    mode: 'model',
    model: { provider: 'cursor', model: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]' }
  }
  render(DefaultPickers, {
    settings: saved,
    models: lists,
    statuses: { cursor: status('ok') },
    onsave: (patch: Partial<AppSettings>) => {
      saves.push(patch)
      onsave()
    }
  })
  const select = screen.getByLabelText('Default workers') as HTMLSelectElement
  expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toContain('Cursor · Grok')
  await fireEvent.change(screen.getByLabelText('Cursor effort'), { target: { value: 'high' } })
  expect(saves).toEqual([
    {
      'providers.workers': {
        mode: 'model',
        model: {
          provider: 'cursor',
          model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
        }
      }
    }
  ])
})

function plan(): PlanView {
  return {
    id: 'p1',
    sessionId: 's1',
    status: 'proposed',
    workers: [
      { name: 'api-retry', task: 'Add retry.', repos: ['api'], model: 'opus', rationale: '' }
    ],
    messageId: 1,
    replacedById: null,
    changesRequested: false,
    createdAt: 1,
    resolvedAt: null
  }
}

it('PlanCard picks Cursor, a base model and an effort, and approves with the full id', async () => {
  render(PlanCard, { plan: plan(), workerModel: 'auto' })
  await fireEvent.change(screen.getByLabelText('Provider for api-retry'), {
    target: { value: 'cursor' }
  })
  const model = screen.getByLabelText('Model for api-retry') as HTMLSelectElement
  expect(model.value).toBe('default[]')
  expect([...model.querySelectorAll('optgroup')].map((g) => g.label)).toContain('Cursor · Grok')
  await fireEvent.change(model, {
    target: { value: 'grok-4.7[context=256k,reasoning_effort=low,fast=false]' }
  })
  await fireEvent.change(screen.getByLabelText('Cursor effort for api-retry'), {
    target: { value: 'high' }
  })
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:plan-decision', {
      sessionId: 's1',
      planId: 'p1',
      decision: 'approve',
      models: {
        'api-retry': {
          provider: 'cursor',
          model: 'grok-4.7[context=256k,reasoning_effort=high,fast=false]'
        }
      }
    })
  )
})

it('ProviderTag shows Cursor with its model label, Auto for the default', () => {
  const { unmount } = render(ProviderTag, {
    runningOn: {
      provider: 'cursor',
      model: 'grok-4.7[context=256k,reasoning_effort=high,fast=true]'
    }
  })
  expect(document.querySelector('[data-provider-tag]')?.textContent).toBe(
    'Cursor · grok-4.7 · high · fast'
  )
  unmount()
  render(ProviderTag, { runningOn: { provider: 'cursor', model: 'default[]' } })
  expect(document.querySelector('[data-provider-tag]')?.textContent).toBe('Cursor · Auto')
})

it('BrainCard shows a Cursor brain and its model', () => {
  render(BrainCard, {
    state: 'idle',
    runningOn: { provider: 'cursor', model: 'default[]' }
  })
  expect(document.querySelector('[data-brain-model]')?.textContent).toBe('Cursor · Auto')
})
