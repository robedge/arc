// @spec: 016-voice-companion
import { tick } from 'svelte'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import SessionScreen from '../../src/renderer/src/lib/components/sessions/SessionScreen.svelte'
import { activeSession } from '../../src/renderer/src/lib/stores/active-session.svelte'
import { nova } from '../../src/renderer/src/lib/stores/nova.svelte'
import { settings } from '../../src/renderer/src/lib/stores/settings.svelte'
import { voiceModels } from '../../src/renderer/src/lib/stores/voice-models.svelte'
import {
  createFakePlayer,
  createFakeTts,
  setEngines,
  type FakePlayer,
  type FakeTts
} from '../../src/renderer/src/lib/nova/engines'
import type {
  AttentionView,
  SessionEventEntry,
  SessionSnapshot
} from '../../src/shared/types/session'
import { permissionView, questionView } from './attention-fixtures'
import { mockArc } from './helpers'

const ATTENTION = 'I need your attention on something.'
const ERROR = ['Something went wrong.', 'The details are in the chat.']

let stored: Record<string, unknown>
let tts: FakeTts
let player: FakePlayer
let initial: { attention: AttentionView[]; events: SessionEventEntry[] }

const entry = (id: number, kind: string): SessionEventEntry => ({
  id,
  sessionId: 's1',
  at: 1,
  kind,
  text: 'x',
  workerId: null
})

beforeEach(() => {
  stored = { 'voice.voiceId': 'af_heart', 'voice.speed': 1, 'voice.speakPolicy': 'all' }
  stored['voice.muted'] = false
  initial = { attention: [], events: [] }
  tts = createFakeTts()
  player = createFakePlayer()
  setEngines({ tts, player })
  settings.reset()
  voiceModels.seed([])
  mockArc((channel, request) => {
    if (channel === 'sessions:open') {
      const snapshot: SessionSnapshot = {
        header: {
          id: (request as { sessionId: string }).sessionId,
          groupId: 'g1',
          name: 'Fix sync',
          mode: 'autonomous',
          workerLimit: 4,
          workers: { mode: 'auto' },
          brainModel: 'sonnet',
          autoApprove: false,
          skipApprovals: false,
          allowRules: [],
          status: 'active',
          createdAt: 1,
          lastActiveAt: 1,
          branches: []
        },
        messages: [],
        events: initial.events,
        workers: [],
        plan: null,
        attention: initial.attention,
        knowledgeSuggestions: [],
        brainState: 'idle',
        changedFileCount: 0,
        seq: 0
      }
      return { ok: true, data: snapshot }
    }
    if (channel === 'settings:get') return { ok: true, data: { ...stored } }
    if (channel === 'settings:set') {
      Object.assign(stored, request as object)
      return { ok: true, data: { ...stored } }
    }
    if (channel === 'voice:models-status') {
      return {
        ok: true,
        data: {
          fake: true,
          models: [{ id: 'kokoro', kind: 'tts', state: 'ready', bytes: 1, totalBytes: 1 }]
        }
      }
    }
    return { ok: true, data: {} }
  })
})
afterEach(() => {
  cleanup()
  activeSession.close()
  nova.close()
  setEngines()
})

async function openPanel(): Promise<void> {
  // Voice ready before the panel opens, so seeding (not "voice not ready") is what keeps old items quiet.
  await voiceModels.load()
  await activeSession.open('s1')
  render(SessionScreen)
  await fireEvent.click(screen.getByRole('button', { name: 'Nova' }))
  await waitFor(() => expect(voiceModels.ttsReady).toBe(true))
  await waitFor(() => expect(settings.values).not.toBeNull())
  await tick()
}

const push = (requests: AttentionView[]): void =>
  activeSession.applyAttention({ sessionId: 's1', requests })
const state = (): Element | null => document.querySelector('[data-nova-state]')
const lastSpoken = (): string | null => state()?.getAttribute('data-nova-last-spoken') ?? null

it('announces a new Needs attention item once, and not again on a repeat push', async () => {
  await openPanel()
  const p1 = permissionView({ id: 'p1', from: 'W2 api-retry' })
  push([p1])
  await waitFor(() => expect(tts.sentences).toEqual([ATTENTION]))
  expect(lastSpoken()).toBe(ATTENTION)
  await waitFor(() => {
    player.finishAll()
    expect(state()?.getAttribute('data-nova-state')).toBe('idle')
  })
  push([p1])
  await tick()
  expect(tts.sentences).toEqual([ATTENTION])
})

it('does not announce items already waiting when the panel opens', async () => {
  initial.attention = [permissionView({ id: 'p0', from: 'W1' })]
  await openPanel()
  push([permissionView({ id: 'p0', from: 'W1' })])
  await tick()
  expect(tts.sentences).toEqual([])
  // Something is already waiting, so a new item joins it quietly.
  push([permissionView({ id: 'p0', from: 'W1' }), questionView({ id: 'q1', from: 'Brain' })])
  await tick()
  expect(tts.sentences).toEqual([])
  // Once Needs attention is empty, the next item is announced again.
  push([])
  await tick()
  push([questionView({ id: 'q2', from: 'Brain' })])
  await waitFor(() => expect(tts.sentences).toEqual([ATTENTION]))
})

it('announces once while items keep arriving one at a time', async () => {
  await openPanel()
  const p1 = permissionView({ id: 'p1', from: 'W1' })
  const p2 = permissionView({ id: 'p2', from: 'W2' })
  push([p1])
  await waitFor(() => expect(tts.sentences).toEqual([ATTENTION]))
  await waitFor(() => {
    player.finishAll()
    expect(state()?.getAttribute('data-nova-state')).toBe('idle')
  })
  push([p1, p2])
  await tick()
  push([p1, p2, questionView({ id: 'q1', from: 'Brain' })])
  await tick()
  expect(tts.sentences).toEqual([ATTENTION])
  // Answered one: the rest still wait, so a new arrival stays quiet.
  push([p2, permissionView({ id: 'p3', from: 'W3' })])
  await tick()
  expect(tts.sentences).toEqual([ATTENTION])
})

it('says nothing when muted, and unmuting does not replay the item', async () => {
  stored['voice.muted'] = true
  await openPanel()
  const p1 = permissionView({ id: 'p1', from: 'W2' })
  push([p1])
  await tick()
  expect(tts.sentences).toEqual([])
  await nova.setMuted(false)
  push([p1])
  await tick()
  expect(tts.sentences).toEqual([])
})

it('says one sentence for several items arriving together', async () => {
  await openPanel()
  push([
    permissionView({ id: 'p1', from: 'W1' }),
    permissionView({ id: 'p2', from: 'W2' }),
    questionView({ id: 'q1', from: 'Brain' })
  ])
  await waitFor(() => expect(tts.sentences).toEqual([ATTENTION]))
  await tick()
  expect(tts.sentences).toEqual([ATTENTION])
})

it('announces a new brain error once and returns to idle; older errors are skipped', async () => {
  initial.events = [entry(1, 'error')]
  await openPanel()
  expect(tts.sentences).toEqual([])
  activeSession.events = [entry(1, 'error'), entry(2, 'brain-stopped')]
  await waitFor(() => expect(tts.sentences).toEqual(ERROR))
  expect(lastSpoken()).toBe(ERROR.join(' '))
  await waitFor(() => {
    player.finishAll()
    expect(state()?.getAttribute('data-nova-state')).toBe('idle')
  })
  activeSession.events = [entry(1, 'error'), entry(2, 'brain-stopped'), entry(3, 'info')]
  await tick()
  expect(tts.sentences).toEqual(ERROR)
})
