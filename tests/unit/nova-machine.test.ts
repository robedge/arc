// @spec: 016-voice-companion
import { describe, expect, it } from 'vitest'
import {
  brainTurnChange,
  initialState,
  transition,
  type MachineEvent,
  type MachineState
} from '../../src/renderer/src/lib/nova/machine'

const start = (over: Partial<MachineState> = {}): MachineState => ({
  ...initialState({ muted: false, policy: 'all' }),
  ...over
})

function run(events: MachineEvent[], from: MachineState = start()) {
  let state = from
  const effects: ReturnType<typeof transition>['effects'] = []
  for (const event of events) {
    const next = transition(state, event)
    state = next.state
    effects.push(...next.effects)
  }
  return { state, effects }
}

describe('nova machine: speaking', () => {
  it('goes thinking, speaking, idle for a typed answer', () => {
    let r = run([{ type: 'brainThinking' }])
    expect(r.state.mode).toBe('thinking')
    r = run([{ type: 'brainSettled', text: 'All done.' }], r.state)
    expect(r.state.mode).toBe('speaking')
    expect(r.effects).toEqual([{ type: 'speak', text: 'All done.' }])
    r = run([{ type: 'speakDone' }], r.state)
    expect(r.state.mode).toBe('idle')
    expect(r.state.turnActive).toBe(false)
  })

  it('speaks when the brain stops at waiting (plan or question), the same as idle', () => {
    // The store sends brainSettled when brainState leaves thinking for idle or waiting.
    const r = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Plan ready.' }])
    expect(r.state.mode).toBe('speaking')
    expect(r.effects).toEqual([{ type: 'speak', text: 'Plan ready.' }])
  })

  it('returns to idle and says nothing when there is nothing to say', () => {
    const r = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: '' }])
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([])
  })

  it('ignores a turn that was already running when the panel opened', () => {
    const r = run([{ type: 'brainSettled', text: 'Late answer.' }])
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([])
  })

  it('keeps speaking when a new turn starts during speech, and queues its answer', () => {
    const r = run([
      { type: 'brainThinking' },
      { type: 'brainSettled', text: 'One.' },
      { type: 'brainThinking' },
      { type: 'brainSettled', text: 'Two.' }
    ])
    expect(r.state.mode).toBe('speaking')
    expect(r.effects).toEqual([
      { type: 'speak', text: 'One.' },
      { type: 'speak', text: 'Two.' }
    ])
  })
})

describe('nova machine: stop, mute, close', () => {
  const speaking = (): MachineState =>
    run([{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Hello.' }]).state

  it('Stop ends speech at once and returns to idle', () => {
    const r = run([{ type: 'stop' }], speaking())
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([{ type: 'stopSpeech' }])
  })

  it('Stop while idle does nothing', () => {
    expect(run([{ type: 'stop' }]).effects).toEqual([])
  })

  it('Stop while thinking drops that answer', () => {
    const r = run([
      { type: 'brainThinking' },
      { type: 'stop' },
      { type: 'brainSettled', text: 'No.' }
    ])
    expect(r.state.mode).toBe('idle')
    expect(r.effects.filter((e) => e.type === 'speak')).toEqual([])
  })

  it('Mute stops speech and keeps later answers silent', () => {
    let r = run([{ type: 'mute', muted: true }], speaking())
    expect(r.state.muted).toBe(true)
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([{ type: 'stopSpeech' }])
    r = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Quiet.' }], r.state)
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([])
  })

  it('Mute while thinking silences that answer too', () => {
    const r = run([
      { type: 'brainThinking' },
      { type: 'mute', muted: true },
      { type: 'brainSettled', text: 'Quiet.' }
    ])
    expect(r.state.mode).toBe('idle')
    expect(r.effects.filter((e) => e.type === 'speak')).toEqual([])
  })

  it('unmuting lets the next answer be spoken', () => {
    const r = run(
      [
        { type: 'mute', muted: false },
        { type: 'brainThinking' },
        { type: 'brainSettled', text: 'Loud.' }
      ],
      start({ muted: true })
    )
    expect(r.effects).toEqual([{ type: 'speak', text: 'Loud.' }])
  })

  it('close stops speech and forgets the turn', () => {
    const r = run([{ type: 'close' }], speaking())
    expect(r.state.mode).toBe('idle')
    expect(r.state.turnActive).toBe(false)
    expect(r.effects).toEqual([{ type: 'stopSpeech' }])
  })
})

describe('nova machine: speak policy', () => {
  it('under all, a typed answer is spoken', () => {
    const r = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Typed.' }])
    expect(r.effects).toEqual([{ type: 'speak', text: 'Typed.' }])
  })

  it('under spoken-only, a typed answer is not spoken and the state returns to idle', () => {
    const r = run(
      [{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Typed.' }],
      start({ policy: 'spoken-only' })
    )
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([])
  })

  it('under spoken-only, an answer to a turn marked spoken is spoken', () => {
    const r = run(
      [{ type: 'markSpoken' }, { type: 'brainThinking' }, { type: 'brainSettled', text: 'Said.' }],
      start({ policy: 'spoken-only' })
    )
    expect(r.effects).toEqual([{ type: 'speak', text: 'Said.' }])
  })

  it('the spoken mark covers one turn only', () => {
    const r = run(
      [
        { type: 'markSpoken' },
        { type: 'brainThinking' },
        { type: 'brainSettled', text: 'Said.' },
        { type: 'speakDone' },
        { type: 'brainThinking' },
        { type: 'brainSettled', text: 'Typed.' }
      ],
      start({ policy: 'spoken-only' })
    )
    expect(r.effects).toEqual([{ type: 'speak', text: 'Said.' }])
  })

  it('a policy change applies to the next turn', () => {
    const r = run(
      [
        { type: 'policy', policy: 'all' },
        { type: 'brainThinking' },
        { type: 'brainSettled', text: 'Now.' }
      ],
      start({ policy: 'spoken-only' })
    )
    expect(r.effects).toEqual([{ type: 'speak', text: 'Now.' }])
  })
})

describe('nova machine: brain state changes', () => {
  it('a turn starts when the brain starts thinking', () => {
    expect(brainTurnChange('idle', 'thinking')).toBe('started')
    expect(brainTurnChange('waiting', 'thinking')).toBe('started')
  })

  it('a turn settles when thinking ends at idle', () => {
    expect(brainTurnChange('thinking', 'idle')).toBe('settled')
  })

  it('a turn settles when thinking ends at waiting (plan approval or a question)', () => {
    expect(brainTurnChange('thinking', 'waiting')).toBe('settled')
  })

  it('other changes are not turn boundaries', () => {
    expect(brainTurnChange('idle', 'idle')).toBeNull()
    expect(brainTurnChange('thinking', 'thinking')).toBeNull()
    expect(brainTurnChange('waiting', 'idle')).toBeNull()
    expect(brainTurnChange('idle', 'waiting')).toBeNull()
  })
})

describe('nova machine: hands-free conversation', () => {
  const listening = (over: Partial<MachineState> = {}): MachineState =>
    run([{ type: 'start' }], start(over)).state

  it('Start begins listening with a conversation running', () => {
    const r = run([{ type: 'start' }])
    expect(r.state.mode).toBe('listening')
    expect(r.state.conversation).toBe(true)
    expect(r.state.utterance).toBe('none')
  })

  it('runs the loop: speech, final text, thinking, speaking, listening again', () => {
    let r = run([{ type: 'speechStart' }, { type: 'speechEnd' }], listening())
    expect(r.state.mode).toBe('listening')
    expect(r.state.utterance).toBe('processing')
    r = run([{ type: 'final', text: 'What are the workers doing?' }], r.state)
    expect(r.state.mode).toBe('thinking')
    expect(r.effects).toEqual([{ type: 'send', text: 'What are the workers doing?' }])
    r = run(
      [{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Two are running.' }],
      r.state
    )
    expect(r.state.mode).toBe('speaking')
    expect(r.effects).toEqual([{ type: 'speak', text: 'Two are running.' }])
    r = run([{ type: 'speakDone' }], r.state)
    expect(r.state.mode).toBe('listening')
    expect(r.state.conversation).toBe(true)
  })

  it('goes back to listening when the answer is muted or empty', () => {
    let r = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: '' }], listening())
    expect(r.state.mode).toBe('listening')
    r = run(
      [{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Hi.' }],
      listening({ muted: true })
    )
    expect(r.state.mode).toBe('listening')
    expect(r.effects).toEqual([])
  })

  it('ignores speech while Nova is speaking or thinking', () => {
    for (const mode of ['speaking', 'thinking'] as const) {
      const r = run([{ type: 'speechStart' }], listening({ mode }))
      expect(r.state.mode).toBe(mode)
      expect(r.state.utterance).toBe('none')
    }
  })

  it('a second speechStart while one is being processed changes nothing', () => {
    const r = run(
      [{ type: 'speechStart' }, { type: 'speechEnd' }, { type: 'speechStart' }],
      listening()
    )
    expect(r.state.utterance).toBe('processing')
  })

  it('a turn that sent text is marked for the answer only through the send effect', () => {
    const r = run(
      [{ type: 'speechStart' }, { type: 'speechEnd' }, { type: 'final', text: 'Hi' }],
      listening()
    )
    expect(r.state.pendingSpoken).toBe(false)
  })

  it('a send that failed returns to listening', () => {
    let r = run(
      [{ type: 'speechStart' }, { type: 'speechEnd' }, { type: 'final', text: 'Hi' }],
      listening()
    )
    r = run([{ type: 'sendFailed' }], r.state)
    expect(r.state.mode).toBe('listening')
    expect(r.state.pendingSpoken).toBe(false)
  })

  it('ten seconds of silence ends the conversation and returns to idle', () => {
    const r = run([{ type: 'silenceTimeout' }], listening())
    expect(r.state.mode).toBe('idle')
    expect(r.state.conversation).toBe(false)
    expect(r.effects).toEqual([{ type: 'endConversation' }])
  })

  it('the silence timeout does nothing while speech is being captured', () => {
    const r = run([{ type: 'speechStart' }, { type: 'silenceTimeout' }], listening())
    expect(r.state.mode).toBe('listening')
    expect(r.state.conversation).toBe(true)
  })

  it('Cancel discards the turn, sends nothing and returns to idle', () => {
    const r = run([{ type: 'speechStart' }, { type: 'cancel' }], listening())
    expect(r.state.mode).toBe('idle')
    expect(r.state.conversation).toBe(false)
    expect(r.state.utterance).toBe('none')
    expect(r.effects).toEqual([{ type: 'cancelUtterance' }, { type: 'endConversation' }])
  })

  it('a final text that arrives after Cancel is dropped', () => {
    const r = run(
      [
        { type: 'speechStart' },
        { type: 'speechEnd' },
        { type: 'cancel' },
        { type: 'final', text: 'late' }
      ],
      listening()
    )
    expect(r.state.mode).toBe('idle')
    expect(r.effects.some((e) => e.type === 'send')).toBe(false)
  })

  it('an empty result says sorry and listens again, sending nothing', () => {
    let r = run([{ type: 'speechStart' }, { type: 'speechEnd' }], listening())
    r = run([{ type: 'empty', speak: true }], r.state)
    expect(r.state.mode).toBe('speaking')
    expect(r.state.utterance).toBe('none')
    expect(r.effects).toEqual([{ type: 'speak', text: "Sorry, I didn't catch that." }])
    r = run([{ type: 'speakDone' }], r.state)
    expect(r.state.mode).toBe('listening')
    expect(r.state.conversation).toBe(true)
  })

  it('an empty result while muted just listens again', () => {
    const r = run(
      [{ type: 'speechStart' }, { type: 'speechEnd' }, { type: 'empty', speak: true }],
      listening({ muted: true })
    )
    expect(r.state.mode).toBe('listening')
    expect(r.state.utterance).toBe('none')
    expect(r.effects).toEqual([])
  })

  it('End stops listening and speaking and returns to idle', () => {
    const r = run([{ type: 'end' }], listening({ mode: 'speaking', turnActive: true }))
    expect(r.state.mode).toBe('idle')
    expect(r.state.conversation).toBe(false)
    expect(r.state.turnActive).toBe(false)
    expect(r.effects).toEqual([{ type: 'stopSpeech' }, { type: 'endConversation' }])
  })

  it('closing the panel ends the conversation and drops a half-heard turn', () => {
    const r = run([{ type: 'speechStart' }, { type: 'close' }], listening())
    expect(r.state.mode).toBe('idle')
    expect(r.effects).toEqual([{ type: 'cancelUtterance' }, { type: 'endConversation' }])
  })

  it('Stop during speech returns to listening while the conversation runs', () => {
    const r = run([{ type: 'stop' }], listening({ mode: 'speaking' }))
    expect(r.state.mode).toBe('listening')
    expect(r.effects).toEqual([{ type: 'stopSpeech' }])
  })

  it('Mute during speech returns to listening while the conversation runs', () => {
    const r = run([{ type: 'mute', muted: true }], listening({ mode: 'speaking' }))
    expect(r.state.mode).toBe('listening')
  })

  it('a typed turn does not pull a listening conversation into Thinking', () => {
    const r = run([{ type: 'brainThinking' }], listening())
    expect(r.state.mode).toBe('listening')
    expect(r.state.turnActive).toBe(true)
  })

  it('Start during a running turn keeps the current state and listens afterwards', () => {
    const r = run([{ type: 'start' }], start({ mode: 'speaking', turnActive: false }))
    expect(r.state.mode).toBe('speaking')
    expect(run([{ type: 'speakDone' }], r.state).state.mode).toBe('listening')
  })
})

describe('nova machine: barge-in', () => {
  const talking = (over: Partial<MachineState> = {}): MachineState =>
    run(
      [
        { type: 'start' },
        { type: 'brainThinking' },
        { type: 'brainSettled', text: 'A long answer.' }
      ],
      start({ pendingSpoken: true, ...over })
    ).state

  it('interrupts speech: stops it, starts an utterance and goes to listening', () => {
    const before = talking()
    expect(before.mode).toBe('speaking')
    const r = run([{ type: 'bargeIn' }], before)
    expect(r.state.mode).toBe('listening')
    expect(r.state.utterance).toBe('capturing')
    expect(r.state.conversation).toBe(true)
    expect(r.state.turnActive).toBe(false)
    expect(r.effects).toEqual([{ type: 'stopSpeech' }, { type: 'beginUtterance' }])
  })

  it('then carries on like any utterance: the pause and the words go to the brain', () => {
    const r = run(
      [{ type: 'bargeIn' }, { type: 'speechEnd' }, { type: 'final', text: 'Stop that.' }],
      talking()
    )
    expect(r.state.mode).toBe('thinking')
    expect(r.effects.at(-1)).toEqual({ type: 'send', text: 'Stop that.' })
  })

  it('does nothing outside a conversation (a preview or typed answer is not interrupted)', () => {
    const typed = run([{ type: 'brainThinking' }, { type: 'brainSettled', text: 'Hi.' }]).state
    expect(typed.mode).toBe('speaking')
    const r = run([{ type: 'bargeIn' }], typed)
    expect(r.state).toEqual(typed)
    expect(r.effects).toEqual([])
  })

  it.each(['idle', 'listening', 'thinking'] as const)('does nothing while %s', (mode) => {
    const state = start({ mode, conversation: true })
    const r = run([{ type: 'bargeIn' }], state)
    expect(r.state).toEqual(state)
    expect(r.effects).toEqual([])
  })

  it('does nothing when muted', () => {
    const state = talking({ muted: true })
    const r = run([{ type: 'bargeIn' }], { ...state, mode: 'speaking' })
    expect(r.state.mode).toBe('speaking')
    expect(r.effects).toEqual([])
  })
})

describe('nova machine: alerts', () => {
  const said = (r: ReturnType<typeof run>): string[] =>
    r.effects.flatMap((e) => (e.type === 'speak' ? [e.text] : []))

  it('says the attention line from idle and returns to idle', () => {
    const r = run([{ type: 'attentionNew' }])
    expect(said(r)).toEqual(['I need your attention on something.'])
    expect(r.state.mode).toBe('speaking')
    expect(run([{ type: 'speakDone' }], r.state).state.mode).toBe('idle')
  })

  it('says the error line and returns to listening during a conversation', () => {
    const r = run([{ type: 'brainError' }], start({ mode: 'listening', conversation: true }))
    expect(said(r)).toEqual(['Something went wrong. The details are in the chat.'])
    expect(run([{ type: 'speakDone' }], r.state).state.mode).toBe('listening')
  })

  it('says nothing when muted', () => {
    const r = run([{ type: 'attentionNew' }, { type: 'brainError' }], start({ muted: true }))
    expect(r.effects).toEqual([])
    expect(r.state.mode).toBe('idle')
  })

  it('queues behind an answer being spoken without cutting it', () => {
    const r = run([{ type: 'attentionNew' }], start({ mode: 'speaking' }))
    expect(said(r)).toEqual(['I need your attention on something.'])
    expect(r.effects.some((e) => e.type === 'stopSpeech')).toBe(false)
    expect(r.state.mode).toBe('speaking')
  })

  it('keeps Thinking for a running turn', () => {
    const r = run([{ type: 'attentionNew' }], start({ mode: 'thinking', turnActive: true }))
    expect(said(r)).toEqual(['I need your attention on something.'])
    expect(r.state.mode).toBe('thinking')
    expect(run([{ type: 'speakDone' }], r.state).state.mode).toBe('thinking')
  })
})
