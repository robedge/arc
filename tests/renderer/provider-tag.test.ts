import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import ProviderTag from '../../src/renderer/src/lib/components/ui/ProviderTag.svelte'
import BrainCard from '../../src/renderer/src/lib/components/sessions/BrainCard.svelte'
import PlanCard from '../../src/renderer/src/lib/components/sessions/PlanCard.svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import type { RunningOn } from '../../src/shared/types/provider'
import type { PlanView, WorkerView } from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const claude: RunningOn = { provider: 'claude', model: 'sonnet' }
const codex: RunningOn = { provider: 'codex', model: 'gpt-5.5' }
const reason = 'Codex is not signed in. Run codex login, then start the worker again.'
const fallback: RunningOn = {
  provider: 'claude',
  model: 'sonnet',
  requestedProvider: 'codex',
  fallbackReason: reason
}

function worker(over: Partial<WorkerView> = {}): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: [],
    model: 'sonnet',
    status: 'working',
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

beforeEach(() => {
  mockHarness(() => ({ ok: true, data: undefined }))
})
afterEach(cleanup)

const tag = (): HTMLElement | null => document.querySelector('[data-provider-tag]')

it('ProviderTag shows the plain Claude label with no title', () => {
  render(ProviderTag, { runningOn: claude })
  expect(tag()?.textContent).toBe('Claude · Sonnet')
  expect(tag()?.hasAttribute('title')).toBe(false)
})

it('ProviderTag shows the Codex label', () => {
  render(ProviderTag, { runningOn: codex })
  expect(tag()?.textContent).toBe('Codex · gpt-5.5')
})

it('ProviderTag shows the fallback label with the reason as a title and for screen readers', () => {
  render(ProviderTag, { runningOn: fallback })
  expect(tag()?.getAttribute('title')).toBe(reason)
  expect(tag()?.textContent).toContain('Claude (Codex unavailable)')
  expect(tag()?.querySelector('.sr-only')?.textContent).toContain(reason)
})

it('ProviderTag shows the reason as visible text with showReason', () => {
  render(ProviderTag, { runningOn: fallback, showReason: true })
  expect(tag()?.querySelector('[data-provider-reason]')?.textContent).toBe(reason)
})

it('ProviderTag falls back to the bare model when runningOn is missing', () => {
  render(ProviderTag, { model: 'haiku' })
  expect(tag()?.textContent).toBe('haiku')
})

it('WorkerCard renders the label from runningOn, not worker.model', () => {
  render(WorkerCard, { worker: worker({ runningOn: codex }), onopen: () => {} })
  expect(document.querySelector('[data-worker-model]')?.textContent).toBe('Codex · gpt-5.5')
})

it('WorkerCard falls back to worker.model when runningOn is missing', () => {
  render(WorkerCard, { worker: worker(), onopen: () => {} })
  expect(document.querySelector('[data-worker-model]')?.textContent).toBe('sonnet')
})

it('WorkerDetails shows the fallback label and its full reason', () => {
  render(WorkerDetails, { worker: worker({ runningOn: fallback }), onclose: () => {} })
  const el = document.querySelector('[data-worker-details]')
  expect(el?.textContent).toContain('Claude (Codex unavailable)')
  expect(el?.querySelector('[data-provider-reason]')?.textContent).toBe(reason)
})

it('BrainCard renders the brain label', () => {
  render(BrainCard, { state: 'idle', runningOn: codex })
  expect(document.querySelector('[data-brain-model]')?.textContent).toBe('Codex · gpt-5.5')
})

it('PlanCard renders each planned worker label from runningOn', () => {
  const plan: PlanView = {
    id: 'p1',
    sessionId: 's1',
    status: 'proposed',
    workers: [
      {
        name: 'api-retry',
        task: 'Add retry.',
        repos: [],
        model: 'opus',
        rationale: '',
        runningOn: codex
      },
      {
        name: 'web',
        task: 'Show.',
        repos: [],
        model: 'haiku',
        rationale: '',
        runningOn: fallback
      }
    ],
    messageId: 1,
    replacedById: null,
    changesRequested: false,
    createdAt: 1,
    resolvedAt: null
  }
  render(PlanCard, { plan, workerModel: 'auto' })
  const labels = [...document.querySelectorAll('[data-plan-provider]')].map((e) => e.textContent)
  expect(labels[0]).toBe('Codex · gpt-5.5')
  expect(labels[1]).toContain('Claude (Codex unavailable)')
})

it('a Cursor-requested worker card shows the fallback line with the full reason', () => {
  const cursorReason =
    "Cursor isn't signed in, so W2 runs on Claude. Run agent login in Terminal to use Cursor."
  const runningOn: RunningOn = {
    provider: 'claude',
    model: 'sonnet',
    requestedProvider: 'cursor',
    fallbackReason: cursorReason
  }
  render(WorkerDetails, { worker: worker({ runningOn }), onclose: () => {} })
  expect(tag()?.textContent).toContain('Claude (Cursor unavailable)')
  expect(document.querySelector('[data-provider-reason]')?.textContent).toBe(cursorReason)
})
