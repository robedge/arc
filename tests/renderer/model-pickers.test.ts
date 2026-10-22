import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { AppSettings, ProviderModels, ProviderStatus } from '../../src/shared/types/provider'
import type { SessionHeader as Header } from '../../src/shared/types/session'
import SessionHeader from '../../src/renderer/src/lib/components/sessions/SessionHeader.svelte'
import ProvidersSettings from '../../src/renderer/src/lib/components/settings/ProvidersSettings.svelte'
import { models } from '../../src/renderer/src/lib/stores/models.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { mockHarness } from './helpers'

const codexModels: ProviderModels = {
  claude: [
    { ref: { provider: 'claude', model: 'opus' }, label: 'Opus', tier: 'deep', isDefault: false },
    {
      ref: { provider: 'claude', model: 'sonnet' },
      label: 'Sonnet',
      tier: 'balanced',
      isDefault: true
    }
  ],
  codex: [
    {
      ref: { provider: 'codex', model: 'gpt-5.5' },
      label: 'gpt-5.5',
      tier: 'deep',
      isDefault: true
    }
  ],
  cursor: []
}
const noCodex: ProviderModels = { ...codexModels, codex: [] }

const status = (state: ProviderStatus['state']): ProviderStatus => ({
  provider: 'codex',
  state,
  message: '',
  checkedAt: 1
})

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
let modelsReply: ProviderModels

beforeEach(() => {
  providers.reset()
  models.reset()
  settings.reset()
  modelsReply = codexModels
  saved = {
    'providers.brain': { provider: 'claude', model: 'sonnet' },
    'providers.workers': { mode: 'auto' },
    'usage.checkClaudePlanOnLaunch': true,
    'agents.loadOff': { brain: [], workers: [] }
  }
  invoke = mockHarness((channel, request) => {
    if (channel === 'providers:models') return { ok: true, data: modelsReply }
    if (channel === 'settings:get') return { ok: true, data: saved }
    if (channel === 'settings:set') {
      saved = { ...saved, ...(request as Partial<AppSettings>) }
      return { ok: true, data: saved }
    }
    if (channel === 'providers:get') return { ok: true, data: {} }
    return { ok: true, data: undefined }
  })
})
afterEach(cleanup)

async function openWorkers(): Promise<HTMLElement> {
  await fireEvent.click(screen.getByRole('button', { name: 'Worker model' }))
  return screen.getByRole('menu')
}

it('the models store loads and refetches on demand', async () => {
  await models.load()
  expect(models.lists.codex).toHaveLength(1)
  modelsReply = noCodex
  await models.load()
  expect(models.lists.codex).toEqual([])
})

it('Workers offers Auto, Claude, Codex, then models grouped by provider', async () => {
  providers.set({ codex: status('ok') })
  models.lists = codexModels
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  const menu = await openWorkers()
  const names = within(menu)
    .getAllByRole('menuitemradio')
    .map((e) => e.textContent!.replace('✓', '').trim())
  expect(names).toEqual(['Auto', 'Claude', 'Codex', 'Opus', 'Sonnet', 'gpt-5.5'])
  expect(within(menu).getByRole('group', { name: 'Claude' })).toBeTruthy()
  const codexGroup = within(menu).getByRole('group', { name: 'Codex' })
  await fireEvent.click(within(codexGroup).getByRole('menuitemradio', { name: 'gpt-5.5' }))
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    workers: { mode: 'model', model: { provider: 'codex', model: 'gpt-5.5' } }
  })
})

it('Workers hides Codex when it is unavailable and not picked', async () => {
  providers.set({ codex: status('signed_out') })
  models.lists = noCodex
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  const menu = await openWorkers()
  const names = within(menu)
    .getAllByRole('menuitemradio')
    .map((e) => e.textContent!.replace('✓', '').trim())
  expect(names).toEqual(['Auto', 'Claude', 'Opus', 'Sonnet'])
  expect(within(menu).queryByRole('group', { name: 'Codex' })).toBeNull()
})

it('a picked Codex stays, selected and flagged unavailable, when Codex is down', async () => {
  providers.set({ codex: status('signed_out') })
  models.lists = noCodex
  render(SessionHeader, {
    header: { ...header, workers: { mode: 'provider', provider: 'codex' } },
    groupName: 'G',
    onback: () => {}
  })
  const button = screen.getByRole('button', { name: 'Worker model' })
  expect(button.textContent).toContain('Workers · Codex (unavailable)')
  const item = within(await openWorkers()).getByRole('menuitemradio', {
    name: /Codex \(unavailable\)/
  })
  expect(item.getAttribute('aria-checked')).toBe('true')
})

it.each([
  [{ mode: 'provider', provider: 'claude' }, 'Workers · Claude'],
  [{ mode: 'provider', provider: 'codex' }, 'Workers · Codex'],
  [{ mode: 'model', model: { provider: 'codex', model: 'gpt-5.5' } }, 'Workers · Codex gpt-5.5'],
  [{ mode: 'model', model: { provider: 'claude', model: 'sonnet' } }, 'Workers · Sonnet']
] as const)('labels the Workers pick %j', (workers, text) => {
  providers.set({ codex: status('ok') })
  models.lists = codexModels
  render(SessionHeader, { header: { ...header, workers }, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Worker model' }).textContent).toBe(text)
})

it('Brain is grouped by provider and offers Codex models while Codex is ready', async () => {
  providers.set({ codex: status('ok') })
  models.lists = codexModels
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toBe('Brain · Sonnet')
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  const menu = screen.getByRole('menu')
  expect(within(menu).getByRole('group', { name: 'Claude' })).toBeTruthy()
  const codexGroup = within(menu).getByRole('group', { name: 'Codex' })
  await fireEvent.click(within(codexGroup).getByRole('menuitemradio', { name: 'gpt-5.5' }))
  expect(invoke).toHaveBeenCalledWith('sessions:set-config', {
    sessionId: 's1',
    brainModel: { provider: 'codex', model: 'gpt-5.5' }
  })
})

it('Brain hides Codex when it is unavailable', async () => {
  providers.set({ codex: status('signed_out') })
  models.lists = codexModels
  render(SessionHeader, { header, groupName: 'G', onback: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  const menu = screen.getByRole('menu')
  expect(within(menu).getByRole('group', { name: 'Claude' })).toBeTruthy()
  expect(within(menu).queryByRole('group', { name: 'Codex' })).toBeNull()
})

it('a Codex brain is labelled, and flagged unavailable when Codex is down', async () => {
  const codexBrain = { ...header, brainModel: 'gpt-5.5', brainRunningOn: { provider: 'codex' } }
  providers.set({ codex: status('ok') })
  models.lists = codexModels
  const view = render(SessionHeader, {
    header: codexBrain as Header,
    groupName: 'G',
    onback: () => {}
  })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toBe(
    'Brain · Codex gpt-5.5'
  )
  view.unmount()
  providers.set({ codex: status('signed_out') })
  models.lists = noCodex
  render(SessionHeader, { header: codexBrain as Header, groupName: 'G', onback: () => {} })
  expect(screen.getByRole('button', { name: 'Brain model' }).textContent).toBe(
    'Brain · Codex gpt-5.5 (unavailable)'
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Brain model' }))
  const item = within(screen.getByRole('menu')).getByRole('menuitemradio', {
    name: /gpt-5\.5 \(unavailable\)/
  })
  expect(item.getAttribute('aria-checked')).toBe('true')
})

it('Settings Providers: the Workers default saves through settings:set', async () => {
  providers.set({ codex: status('ok') })
  render(ProvidersSettings)
  const select = (await screen.findByLabelText('Default workers')) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('auto'))
  const values = [...select.options].map((o) => o.value)
  expect(values.slice(0, 3)).toEqual(['auto', 'provider:claude', 'provider:codex'])
  await fireEvent.change(select, { target: { value: 'provider:codex' } })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('settings:set', {
      'providers.workers': { mode: 'provider', provider: 'codex' }
    })
  )
})

it('Settings Providers: the Brain default offers Claude and Codex groups', async () => {
  providers.set({ codex: status('ok') })
  render(ProvidersSettings)
  const select = (await screen.findByLabelText('Default brain')) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('claude:sonnet'))
  const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label)
  expect(groups).toEqual(['Claude', 'Codex'])
  await fireEvent.change(select, { target: { value: 'codex:gpt-5.5' } })
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('settings:set', {
      'providers.brain': { provider: 'codex', model: 'gpt-5.5' }
    })
  )
})

it('Settings Providers: a saved Codex default stays, flagged unavailable, when Codex is down', async () => {
  saved = {
    'providers.brain': { provider: 'codex', model: 'gpt-5.5' },
    'providers.workers': { mode: 'provider', provider: 'codex' },
    'usage.checkClaudePlanOnLaunch': true,
    'agents.loadOff': { brain: [], workers: [] }
  }
  modelsReply = noCodex
  providers.set({ codex: status('signed_out') })
  render(ProvidersSettings)
  const brain = (await screen.findByLabelText('Default brain')) as HTMLSelectElement
  await waitFor(() => expect(brain.value).toBe('codex:gpt-5.5'))
  expect(brain.selectedOptions[0]?.textContent).toBe('gpt-5.5 (unavailable)')
  const workers = screen.getByLabelText('Default workers') as HTMLSelectElement
  expect(workers.value).toBe('provider:codex')
  expect(workers.selectedOptions[0]?.textContent).toBe('Codex (unavailable)')
})
