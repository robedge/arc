import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import Conversation from '../../src/renderer/src/lib/components/sessions/Conversation.svelte'
import WorkerDetails from '../../src/renderer/src/lib/components/sessions/WorkerDetails.svelte'
import { canContinue } from '../../src/renderer/src/lib/components/sessions/worker-actions'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import type {
  SessionHeader as Header,
  SessionMessage,
  WorkerView
} from '../../src/shared/types/session'
import { mockHarness } from './helpers'

const header: Header = {
  id: 's1',
  groupId: 'g1',
  name: 'Fix sync',
  mode: 'autonomous',
  workerLimit: 4,
  model: 'auto',
  brainModel: 'sonnet',
  autoApprove: false,
  allowRules: [],
  status: 'active',
  createdAt: 1,
  lastActiveAt: 1,
  branches: []
}

function promptMessage(status: 'open' | 'continued' | 'dismissed'): SessionMessage {
  return {
    id: 7,
    sessionId: 's1',
    role: 'system',
    content: '2 workers were stopped when Arc closed. Continue them?',
    state: 'complete',
    planId: null,
    prompt: { kind: 'continue-workers', workerIds: ['w1', 'w2'], status },
    createdAt: 1,
    updatedAt: 1
  }
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
    status: 'stopped',
    activity: null,
    failureReason: null,
    summary: null,
    stoppedBy: 'quit',
    worktrees: [],
    hasWorkingCopy: true,
    unmergedCommits: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

let refusal: string | null
let invoke: ReturnType<typeof mockHarness>

beforeEach(() => {
  refusal = null
  invoke = mockHarness((channel) => {
    if (channel === 'workers:continue' && refusal)
      return { ok: false, error: { code: 'VALIDATION_FAILED', details: { reason: refusal } } }
    return { ok: true, data: undefined }
  })
  activeSession.setSnapshot({
    header,
    messages: [promptMessage('open')],
    events: [],
    brainState: 'idle',
    changedFileCount: 0,
    plan: null,
    workers: [],
    attention: [],
    seq: 0
  })
})

afterEach(() => {
  cleanup()
  activeSession.close()
})

it('Continue on the prompt continues every worker of the session', async () => {
  render(Conversation)
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(invoke).toHaveBeenCalledWith('workers:continue', { sessionId: 's1', all: true })
})

it('Not now dismisses the prompt message', async () => {
  render(Conversation)
  await fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
  expect(invoke).toHaveBeenCalledWith('sessions:dismiss-prompt', { sessionId: 's1', messageId: 7 })
})

it('a pushed status change replaces the message and hides the buttons', async () => {
  render(Conversation)
  activeSession.applyMessage({ sessionId: 's1', seq: 1, message: promptMessage('continued') })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull())
  expect(screen.queryByRole('button', { name: 'Not now' })).toBeNull()
  expect(document.querySelector('[data-prompt-outcome]')?.textContent).toBe('Continued')
  expect(activeSession.messages).toHaveLength(1)
})

it('a dismissed prompt is tagged Not now', async () => {
  render(Conversation)
  activeSession.applyMessage({ sessionId: 's1', seq: 1, message: promptMessage('dismissed') })
  await waitFor(() =>
    expect(document.querySelector('[data-prompt-outcome]')?.textContent).toBe('Not now')
  )
})

it('Continue is offered only for a stopped worker the user did not stop, with a working copy', () => {
  expect(canContinue(worker())).toBe(true)
  expect(canContinue(worker({ stoppedBy: 'crash' }))).toBe(true)
  expect(canContinue(worker({ stoppedBy: 'user' }))).toBe(false)
  expect(canContinue(worker({ hasWorkingCopy: false }))).toBe(false)
  expect(canContinue(worker({ status: 'working', stoppedBy: null }))).toBe(false)
})

it('worker details show Continue only when it is allowed', () => {
  render(WorkerDetails, { worker: worker({ stoppedBy: 'user' }), onclose: () => {} })
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
  cleanup()
  render(WorkerDetails, { worker: worker(), onclose: () => {} })
  expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
})

it('worker details Continue sends the worker id and shows a refusal reason', async () => {
  refusal = 'The working copy is gone.'
  render(WorkerDetails, { worker: worker(), onclose: () => {} })
  await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(invoke).toHaveBeenCalledWith('workers:continue', { workerId: 'w1' })
  await waitFor(() => expect(screen.getByText('The working copy is gone.')).toBeTruthy())
})
