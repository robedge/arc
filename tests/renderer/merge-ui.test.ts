import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/svelte'
import EventLog from '../../src/renderer/src/lib/components/sessions/EventLog.svelte'
import MessageBubble from '../../src/renderer/src/lib/components/sessions/MessageBubble.svelte'
import WorkerCard from '../../src/renderer/src/lib/components/sessions/WorkerCard.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import type {
  SessionEventEntry,
  SessionMessage,
  WorkerStatus,
  WorkerView
} from '../../src/shared/types/session'
import { mockHarness } from './helpers'

afterEach(cleanup)

function worker(status: WorkerStatus): WorkerView {
  return {
    id: 'w1',
    sessionId: 's1',
    number: 1,
    slug: 'api-retry',
    role: 'worker',
    task: 'Add retry.',
    projectIds: ['api'],
    model: 'sonnet',
    status,
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: null,
    worktrees: [],
    hasWorkingCopy: false,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

const entries: [string, string][] = [
  ['merge', 'Merged W1 api-retry into arc/order-sync'],
  ['merge-resolved', 'Resolved conflict in src/queue.ts'],
  ['merge-conflict', 'Merging W2 web-status hit a conflict in src/status.ts'],
  ['shared', 'Shared W1 → W3: retry helper'],
  ['merge-waiting', 'Session branch update waiting: your checkout of api has unsaved changes'],
  ['plan', 'Plan approved']
]

it('event log maps merge kinds to an icon and tone and keeps the text', () => {
  const events: SessionEventEntry[] = entries.map(([kind, text], i) => ({
    id: i + 1,
    sessionId: 's1',
    at: 0,
    kind,
    text,
    workerId: null
  }))
  render(EventLog, { props: { events } })
  const row = (kind: string): HTMLElement =>
    document.querySelector(`[data-event-kind="${kind}"]`) as HTMLElement
  for (const [kind, text] of entries) expect(row(kind).textContent).toContain(text)
  expect(row('merge').querySelector('[data-event-icon="success"]')?.className).toContain(
    'text-success'
  )
  expect(row('merge-waiting').querySelector('[data-event-icon="warning"]')?.className).toContain(
    'text-attention'
  )
  expect(row('shared').querySelector('[data-event-icon="link"]')?.className).toContain(
    'text-accent'
  )
  expect(row('merge').querySelector('svg')?.getAttribute('aria-label')).toBe('Merged')
  expect(row('plan').querySelector('svg')).toBeNull()
})

it('a merged worker card shows Merged', () => {
  render(WorkerCard, { worker: worker('merged'), onopen: () => {} })
  expect(document.querySelector('[data-worker-status]')?.textContent).toBe('Merged')
})

it('WorkerDetails has no Stop button for a merged worker', async () => {
  mockHarness(() => ({ ok: false, error: { code: 'NOT_FOUND' } }) as never)
  render(WorkerDetails, { worker: worker('merged'), onclose: () => {} })
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
  await waitFor(() => expect(document.querySelector('[data-worker-details]')).toBeTruthy())
})

it('a final summary with per-repo commit lists renders them as code', () => {
  const message: SessionMessage = {
    id: 1,
    sessionId: 's1',
    role: 'brain',
    content:
      'All done. Merged into arc/order-sync:\n\n**api**\n\n```\nabc1234 Add retry\ndef5678 Cap backoff\n```\n',
    state: 'complete',
    planId: null,
    createdAt: 0,
    updatedAt: 0
  }
  render(MessageBubble, { message })
  const code = document.querySelector('pre code') as HTMLElement
  expect(code.textContent).toContain('abc1234 Add retry')
  expect(screen.getByText('api').tagName).toBe('STRONG')
})

it('a merge resolver card reads "Conflict resolver · repo" with its status word and no W-number', () => {
  const resolver: WorkerView = {
    ...worker('working'),
    number: 3,
    slug: 'merge-conflict',
    role: 'resolver',
    worktrees: [{ projectId: 'api', projectName: 'api', path: '/m', baseSha: 'a', headSha: 'a' }]
  }
  render(WorkerCard, { worker: resolver, onopen: () => {} })
  expect(document.querySelector('[data-worker-title]')?.textContent).toBe('Conflict resolver · api')
  expect(document.querySelector('[data-worker-status]')?.textContent).toBe('Working')
  expect(document.body.textContent).not.toContain('W3')
})
