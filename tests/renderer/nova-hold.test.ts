// @spec: 016-voice-companion
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Listener, type ListenerHooks } from '../../src/renderer/src/lib/nova/listener'
import { createFakeListen, type FakeListen } from '../../src/renderer/src/lib/nova/engines'

const SHORT = 1000
let listen: FakeListen
let hooks: ListenerHooks & { finals: string[]; ends: number }
let listener: Listener

beforeEach(async () => {
  vi.useFakeTimers()
  listen = createFakeListen()
  const state = {
    finals: [] as string[],
    ends: 0,
    canStart: () => true,
    canBargeIn: () => false,
    onSpeechStart: () => {},
    onBargeIn: () => {},
    onSpeechEnd: () => {
      state.ends++
    },
    onFinal: (t: string) => {
      state.finals.push(t)
    },
    onLevel: () => {}
  }
  hooks = state
  listener = new Listener(
    () => listen.engines,
    hooks,
    () => SHORT
  )
  await listener.start()
  listen.mic.emit()
  listen.speechStart()
})
afterEach(() => {
  listener.stop()
  vi.useRealTimers()
})

// The detector reports silence after 450 ms, so a hold of N ms has N - 450 ms left.
const silence = (): void => listen.speechEnd()

it('holds three times as long after unfinished words and resumes the same utterance on speech', async () => {
  listener.onPartial('i want to')
  silence()
  await vi.advanceTimersByTimeAsync(2000)
  expect(hooks.ends).toBe(0)
  listen.speechResume()
  await vi.advanceTimersByTimeAsync(5000)
  expect(hooks.ends).toBe(0)
  expect(listen.stt.begins).toHaveLength(1)
  silence()
  await vi.advanceTimersByTimeAsync(1)
  listener.onPartial('i want to open settings')
  await vi.advanceTimersByTimeAsync(SHORT)
  expect(hooks.ends).toBe(1)
  expect(listen.stt.begins).toHaveLength(1)
})

it('ends after the short hold when the words sound finished', async () => {
  listener.onPartial('what time is it')
  silence()
  await vi.advanceTimersByTimeAsync(SHORT - 450 - 10)
  expect(hooks.ends).toBe(0)
  await vi.advanceTimersByTimeAsync(20)
  expect(hooks.ends).toBe(1)
  await vi.advanceTimersByTimeAsync(0)
  expect(hooks.finals).toHaveLength(1)
})

it('keeps sending mic audio while the turn is held', async () => {
  listener.onPartial('and')
  silence()
  const before = listen.stt.pushed.length
  listen.mic.emit()
  expect(listen.stt.pushed.length).toBeGreaterThan(before)
})

it('a late partial during the hold changes the deadline', async () => {
  silence()
  await vi.advanceTimersByTimeAsync(1500)
  expect(hooks.ends).toBe(0)
  listener.onPartial('what time is it')
  await vi.advanceTimersByTimeAsync(0)
  expect(hooks.ends).toBe(1)
})

it('a late partial that sounds unfinished extends the hold', async () => {
  listener.onPartial('open the settings')
  silence()
  await vi.advanceTimersByTimeAsync(300)
  listener.onPartial('open the settings and')
  await vi.advanceTimersByTimeAsync(2000)
  expect(hooks.ends).toBe(0)
  await vi.advanceTimersByTimeAsync(1000)
  expect(hooks.ends).toBe(1)
})

it('cancelUtterance during the hold clears the timer and drops the result', async () => {
  listener.onPartial('and')
  silence()
  listener.cancelUtterance()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(hooks.ends).toBe(0)
  expect(hooks.finals).toEqual([])
  expect(vi.getTimerCount()).toBe(1) // only the level poll
})

it('stop during the hold ends nothing', async () => {
  silence()
  listener.stop()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(hooks.ends).toBe(0)
})
