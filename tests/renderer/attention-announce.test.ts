import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import ConversationTabs from '../../src/renderer/src/lib/components/sessions/ConversationTabs.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type { AttentionView, SessionSnapshot } from '../../src/shared/types/session'
import { branchView, permissionView, questionView } from './attention-fixtures'
import { mockArc } from './helpers'

function load(sessionId: string, attention: AttentionView[]): void {
  const snapshot: SessionSnapshot = {
    header: {
      id: sessionId,
      groupId: 'g1',
      name: 'Fix sync',
      mode: 'autonomous',
      workerLimit: 4,
      workers: { mode: 'auto' },
      brainModel: 'sonnet',
      autoApprove: false,
      allowRules: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
      branches: []
    },
    messages: [],
    events: [],
    workers: [],
    plan: null,
    attention,
    knowledgeSuggestions: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 0
  }
  activeSession.setSnapshot(snapshot)
}

const status = (): HTMLElement =>
  document.querySelector('[data-attention-status][role="status"]') as HTMLElement

beforeEach(() => {
  mockArc(() => ({ ok: true, data: [] }))
  activeSession.close()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('exists with no requests and does not sit inside the dock', () => {
  load('s1', [])
  render(ConversationTabs, { sessionId: 's1', workers: [] })
  expect(status().getAttribute('aria-live')).toBe('polite')
  expect(status().textContent).toBe('')
  expect(status().closest('[data-attention-dock]')).toBeNull()
})

it('announces each new request kind with where it came from', async () => {
  load('s1', [])
  render(ConversationTabs, { sessionId: 's1', workers: [] })
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p1', from: 'W2 api-retry' })]
  })
  await waitFor(() =>
    expect(status().textContent).toBe('New request: Permission from W2 api-retry')
  )
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [
      permissionView({ id: 'p1', from: 'W2 api-retry' }),
      questionView({ id: 'q1', from: 'Brain' })
    ]
  })
  await waitFor(() => expect(status().textContent).toBe('New request: Question from Brain'))
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [
      permissionView({ id: 'p1', from: 'W2 api-retry' }),
      questionView({ id: 'q1', from: 'Brain' }),
      branchView({ id: 'b1', projectName: 'api' })
    ]
  })
  await waitFor(() =>
    expect(status().textContent).toBe('New request: Unsaved changes in api from Arc')
  )
})

it('stays silent for the requests already waiting when a session opens, and for pushes that add nothing', async () => {
  load('s1', [permissionView({ id: 'p1', from: 'W2 api-retry' })])
  render(ConversationTabs, { sessionId: 's1', workers: [] })
  await tick()
  expect(status().textContent).toBe('')
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p1', from: 'W2 api-retry' })]
  })
  await tick()
  expect(status().textContent).toBe('')
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p2', from: 'W3 web' })]
  })
  await waitFor(() => expect(status().textContent).toBe('New request: Permission from W3 web'))
  // Same list again: the text is unchanged and nothing new is said.
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p2', from: 'W3 web' })]
  })
  await tick()
  expect(status().textContent).toBe('New request: Permission from W3 web')
})

it('opening another session with waiting requests does not announce them', async () => {
  load('s1', [])
  render(ConversationTabs, { sessionId: 's1', workers: [] })
  load('s2', [questionView({ id: 'q9', from: 'Brain' })])
  await tick()
  expect(status().textContent).toBe('')
})
