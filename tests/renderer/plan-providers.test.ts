import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import PlanCard from '../../src/renderer/src/lib/components/sessions/PlanCard.svelte'
import { models } from '../../src/renderer/src/lib/stores/models.svelte'
import { providers } from '../../src/renderer/src/lib/stores/providers.svelte'
import type { ProviderModels, ProviderStatus, WorkersPref } from '../../src/shared/types/provider'
import type { PlanView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

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
  codex: [
    {
      ref: { provider: 'codex', model: 'gpt-5.5-mini' },
      label: 'mini',
      tier: 'fast',
      isDefault: false
    },
    {
      ref: { provider: 'codex', model: 'gpt-5.5' },
      label: 'gpt-5.5',
      tier: 'deep',
      isDefault: true
    }
  ],
  cursor: []
}

const codex = (state: ProviderStatus['state']): ProviderStatus => ({
  provider: 'codex',
  state,
  message: '',
  checkedAt: 1
})

function plan(): PlanView {
  return {
    id: 'p1',
    sessionId: 's1',
    status: 'proposed',
    workers: [
      { name: 'api-retry', task: 'Add retry.', repos: ['api'], model: 'opus', rationale: '' },
      { name: 'web-status', task: 'Show.', repos: ['web'], model: 'sonnet', rationale: '' }
    ],
    messageId: 1,
    replacedById: null,
    changesRequested: false,
    createdAt: 1,
    resolvedAt: null
  }
}

const select = (label: string): HTMLSelectElement =>
  screen.getByLabelText(label) as HTMLSelectElement

let invoke: ReturnType<typeof mockHarness>
beforeEach(() => {
  providers.reset()
  models.reset()
  models.lists = lists
  providers.set({ codex: codex('ok') })
  invoke = mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

const open = (workers?: WorkersPref): void => {
  render(PlanCard, { plan: plan(), workerModel: 'auto', workers })
}

it('changing the provider resets the model to that provider default', async () => {
  open()
  expect(select('Model for api-retry').value).toBe('opus')
  await fireEvent.change(select('Provider for api-retry'), { target: { value: 'codex' } })
  expect(select('Model for api-retry').value).toBe('gpt-5.5')
  expect([...select('Model for api-retry').options].map((o) => o.value)).toEqual([
    'gpt-5.5-mini',
    'gpt-5.5'
  ])
  // The other worker is untouched.
  expect(select('Provider for web-status').value).toBe('claude')
  await fireEvent.change(select('Provider for api-retry'), { target: { value: 'claude' } })
  expect(select('Model for api-retry').value).toBe('sonnet')
})

it('Approve sends each worker as a provider and model', async () => {
  open()
  await fireEvent.change(select('Provider for web-status'), { target: { value: 'codex' } })
  await fireEvent.change(select('Model for web-status'), { target: { value: 'gpt-5.5-mini' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:plan-decision', {
      sessionId: 's1',
      planId: 'p1',
      decision: 'approve',
      models: {
        'api-retry': { provider: 'claude', model: 'opus' },
        'web-status': { provider: 'codex', model: 'gpt-5.5-mini' }
      }
    })
  )
})

it('a model pin disables both selects, shows the pinned value and sends no models', async () => {
  open({ mode: 'model', model: { provider: 'codex', model: 'gpt-5.5-mini' } })
  for (const w of ['api-retry', 'web-status']) {
    expect(select(`Provider for ${w}`).disabled).toBe(true)
    expect(select(`Provider for ${w}`).value).toBe('codex')
    expect(select(`Model for ${w}`).disabled).toBe(true)
    expect(select(`Model for ${w}`).value).toBe('gpt-5.5-mini')
  }
  const hint = screen.getByText('Set by Workers in the header')
  expect(select('Model for api-retry').getAttribute('aria-describedby')).toContain(hint.id)
  expect(select('Provider for api-retry').getAttribute('aria-describedby')).toContain(hint.id)
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:plan-decision', {
      sessionId: 's1',
      planId: 'p1',
      decision: 'approve'
    })
  )
})

it('a provider pin disables the provider select and keeps the model select within it', async () => {
  open({ mode: 'provider', provider: 'codex' })
  expect(select('Provider for api-retry').disabled).toBe(true)
  expect(select('Provider for api-retry').value).toBe('codex')
  expect(select('Model for api-retry').disabled).toBe(false)
  // The proposal was a Claude model, so the pinned provider's default shows.
  expect(select('Model for api-retry').value).toBe('gpt-5.5')
  expect(screen.getByText('Set by Workers in the header')).toBeTruthy()
  await fireEvent.change(select('Model for api-retry'), { target: { value: 'gpt-5.5-mini' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('sessions:plan-decision', {
      sessionId: 's1',
      planId: 'p1',
      decision: 'approve',
      models: {
        'api-retry': { provider: 'codex', model: 'gpt-5.5-mini' },
        'web-status': { provider: 'codex', model: 'gpt-5.5' }
      }
    })
  )
})

it('an unpinned card shows no hint and enables both selects', () => {
  open({ mode: 'auto' })
  expect(screen.queryByText('Set by Workers in the header')).toBeNull()
  expect(select('Provider for api-retry').disabled).toBe(false)
  expect(select('Model for api-retry').disabled).toBe(false)
})

it('Codex is hidden from the provider select while unavailable', () => {
  providers.set({ codex: codex('signed_out') })
  open()
  expect([...select('Provider for api-retry').options].map((o) => o.value)).toEqual(['claude'])
})

it('Codex is listed while ready', () => {
  open()
  expect([...select('Provider for api-retry').options].map((o) => o.value)).toEqual([
    'claude',
    'codex'
  ])
})

it('a chosen Codex stays, flagged unavailable, when Codex goes down', async () => {
  open()
  await fireEvent.change(select('Provider for api-retry'), { target: { value: 'codex' } })
  providers.set({ codex: codex('signed_out') })
  await waitFor(() =>
    expect([...select('Provider for api-retry').options].map((o) => o.textContent)).toEqual([
      'Claude',
      'Codex (unavailable)'
    ])
  )
  expect(select('Provider for api-retry').value).toBe('codex')
})
