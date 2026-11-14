import { beforeEach, expect, it } from 'vitest'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import {
  BRAIN_TAB,
  workerTerminals
} from '../../src/renderer/src/lib/stores/worker-terminals.svelte'
import type { AttentionView, SessionMessage, SessionSnapshot } from '../../src/shared/types/session'
import { permissionView } from './attention-fixtures'
import { mockArc } from './helpers'

function msg(id: number, over: Partial<SessionMessage> = {}): SessionMessage {
  return {
    id,
    sessionId: 's1',
    role: 'brain',
    content: '',
    state: 'complete',
    planId: null,
    createdAt: 1,
    updatedAt: 1,
    ...over
  }
}

function snapshot(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    header: {
      id: 's1',
      groupId: 'g1',
      name: 'S',
      mode: 'plan_first',
      workerLimit: 3,
      workers: { mode: 'auto' },
      brainModel: 'sonnet',
      autoApprove: false,
      allowRules: [],
      status: 'active',
      createdAt: 1,
      lastActiveAt: 1,
      branches: []
    },
    messages: [msg(1, { role: 'user', content: 'hi' })],
    events: [],
    workers: [],
    plan: null,
    attention: [],
    knowledgeSuggestions: [],
    brainState: 'idle',
    changedFileCount: 0,
    seq: 10,
    ...over
  }
}

beforeEach(() => {
  mockArc(() => ({ ok: true, data: { messageId: 5 } }))
  activeSession.close()
  activeSession.setSnapshot(snapshot())
})

it('ignores pushes for another session', () => {
  activeSession.applyDelta({ sessionId: 'other', messageId: 2, seq: 11, text: 'x' })
  activeSession.applyBrainState({ sessionId: 'other', seq: 11, state: 'thinking' })
  activeSession.flushStream()
  expect(activeSession.messages).toHaveLength(1)
  expect(activeSession.brainState).toBe('idle')
})

it('drops pushes whose seq is at or below the snapshot seq', () => {
  activeSession.applyDelta({ sessionId: 's1', messageId: 2, seq: 10, text: 'stale' })
  activeSession.applyBrainState({ sessionId: 's1', seq: 9, state: 'thinking' })
  activeSession.applyEvents({
    sessionId: 's1',
    seq: 10,
    entries: [{ id: 1, sessionId: 's1', at: 1, kind: 'k', text: 't', workerId: null }]
  })
  activeSession.flushStream()
  expect(activeSession.messages).toHaveLength(1)
  expect(activeSession.brainState).toBe('idle')
  expect(activeSession.events).toHaveLength(0)
  activeSession.applyBrainState({ sessionId: 's1', seq: 11, state: 'thinking' })
  expect(activeSession.brainState).toBe('thinking')
})

it('creates a streaming brain bubble for an unknown messageId and appends later deltas', () => {
  activeSession.applyDelta({ sessionId: 's1', messageId: 2, seq: 11, text: 'Hel' })
  activeSession.applyDelta({ sessionId: 's1', messageId: 2, seq: 12, text: 'lo' })
  activeSession.flushStream()
  const bubble = activeSession.messages.find((m) => m.id === 2)
  expect(bubble).toMatchObject({ role: 'brain', state: 'streaming', content: 'Hello' })
  activeSession.applyDelta({ sessionId: 's1', messageId: 2, seq: 13, text: '!' })
  activeSession.flushStream()
  expect(activeSession.messages.find((m) => m.id === 2)?.content).toBe('Hello!')
})

it('finalizes the bubble on session:message, replacing streamed text', () => {
  activeSession.applyDelta({ sessionId: 's1', messageId: 2, seq: 11, text: 'Hel' })
  activeSession.applyMessage({
    sessionId: 's1',
    seq: 12,
    message: msg(2, { content: 'Hello world', state: 'complete' })
  })
  expect(activeSession.messages).toHaveLength(2)
  expect(activeSession.messages[1]).toMatchObject({ content: 'Hello world', state: 'complete' })
})

it('appends the sent user message with the returned id', async () => {
  expect(await activeSession.send('question')).toBeNull()
  expect(activeSession.messages.at(-1)).toMatchObject({ id: 5, role: 'user', content: 'question' })
})

it('a renamed event entry updates the header name', () => {
  activeSession.applyEvents({
    sessionId: 's1',
    seq: 11,
    entries: [
      {
        id: 2,
        sessionId: 's1',
        at: 2,
        kind: 'renamed',
        text: 'Session named "Fix login"',
        workerId: null,
        dataJson: '{"name":"Fix login"}'
      }
    ]
  })
  expect(activeSession.header?.name).toBe('Fix login')
})

it('answering the reopen question for the open session does not reopen it', () => {
  const invoke = mockArc(() => ({ ok: true, data: snapshot() }))
  activeSession.dirtyChoice = {
    token: 't1',
    repos: [{ projectId: 'infra', name: 'infra', files: ['a.txt'], fileCount: 1 }]
  }
  expect(activeSession.dirtyChoice?.token).toBe('t1')
  activeSession.resolveDirty({ status: 'ready', sessionId: 's1' })
  expect(activeSession.dirtyChoice).toBeNull()
  expect(invoke).not.toHaveBeenCalled()
  expect(activeSession.sessionId).toBe('s1')
})

it('answerBranchQuestion sends the channel and maps the result to an error text', async () => {
  const invoke = mockArc(() => ({ ok: true, data: { status: 'ok' } }))
  expect(await activeSession.answerBranchQuestion('bq1', 'stash')).toBeNull()
  expect(invoke).toHaveBeenCalledWith('sessions:answer-branch-question', {
    questionId: 'bq1',
    choice: 'stash'
  })
  mockArc(() => ({ ok: true, data: { status: 'not-open' } }))
  expect(await activeSession.answerBranchQuestion('bq1', 'stash')).toBeNull()
  mockArc(() => ({ ok: true, data: { status: 'failed', reason: 'Clash.' } }))
  expect(await activeSession.answerBranchQuestion('bq1', 'carry')).toBe('Clash.')
})

function openWith(attention: AttentionView[]): void {
  mockArc(() => ({ ok: true, data: undefined }))
  activeSession.setSnapshot(snapshot({ attention }))
}

it('toggleAttentionFold flips attentionFolded and a new session starts unfolded', () => {
  openWith([permissionView({ id: 'p1' })])
  activeSession.toggleAttentionFold()
  expect(activeSession.attentionFolded).toBe(true)
  activeSession.toggleAttentionFold()
  expect(activeSession.attentionFolded).toBe(false)
  activeSession.toggleAttentionFold()
  activeSession.close()
  expect(activeSession.attentionFolded).toBe(false)
})

it('a push with a new queue request unfolds; one that only removes a request does not', () => {
  openWith([permissionView({ id: 'p1' }), permissionView({ id: 'p2' })])
  activeSession.toggleAttentionFold()
  activeSession.applyAttention({ sessionId: 's1', requests: [permissionView({ id: 'p1' })] })
  expect(activeSession.attentionFolded).toBe(true)
  activeSession.applyAttention({
    sessionId: 's1',
    requests: [permissionView({ id: 'p1' }), permissionView({ id: 'p3' })]
  })
  expect(activeSession.attentionFolded).toBe(false)
})

it('focusRequest selects the Brain tab, unfolds and bumps the nonce for the same id', () => {
  openWith([permissionView({ id: 'p1' })])
  workerTerminals.active = 'w1'
  activeSession.toggleAttentionFold()
  activeSession.focusRequest('p1')
  expect(workerTerminals.active).toBe(BRAIN_TAB)
  expect(activeSession.attentionFolded).toBe(false)
  const first = activeSession.attentionFocus
  activeSession.focusRequest('p1')
  expect(activeSession.attentionFocus?.requestId).toBe('p1')
  expect(activeSession.attentionFocus?.nonce).toBe((first?.nonce ?? 0) + 1)
  activeSession.focusRequest()
  expect(activeSession.attentionFocus?.requestId).toBeNull()
  workerTerminals.reset()
})
