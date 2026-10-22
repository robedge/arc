import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CURSOR_POLL_MS,
  pollsLongCalls,
  WaitRegistry,
  type PollOutcome
} from '../../../src/main/bridge/polling'
import { BridgeToolError } from '../../../src/main/bridge/types'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Collects the outcome of a promise without awaiting it, so timers can be advanced meanwhile. */
function track<T>(promise: Promise<T>): { value?: T; error?: unknown; settled: boolean } {
  const state: { value?: T; error?: unknown; settled: boolean } = { settled: false }
  promise.then(
    (value) => {
      state.value = value
      state.settled = true
    },
    (error: unknown) => {
      state.error = error
      state.settled = true
    }
  )
  return state
}

describe('pollsLongCalls', () => {
  it('is true for a Cursor agent only', () => {
    const agent = { sessionId: 's', agentId: 'a', role: 'worker' } as const
    expect(pollsLongCalls({ ...agent, provider: 'cursor' })).toBe(true)
    expect(pollsLongCalls({ ...agent, provider: 'claude' })).toBe(false)
    expect(pollsLongCalls({ ...agent, provider: 'codex' })).toBe(false)
    expect(pollsLongCalls(agent)).toBe(false)
  })
})

describe('WaitRegistry', () => {
  it('cuts at 50 s, under the 60 s Cursor limit', () => {
    expect(CURSOR_POLL_MS).toBe(50_000)
  })

  it('returns the value of work that finishes before the cut, and keeps nothing', async () => {
    const waits = new WaitRegistry()
    const work = deferred<string>()
    const outcome = track(waits.run(work.promise, 'the user'))
    await vi.advanceTimersByTimeAsync(49_000)
    expect(outcome.settled).toBe(false)
    work.resolve('done')
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome.value).toEqual({ done: true, value: 'done' })
    expect(waits.size).toBe(0)
  })

  it('returns pending at 50 s with a waitId and who it waits for', async () => {
    const waits = new WaitRegistry()
    const outcome = track(waits.run(new Promise<string>(() => undefined), 'the user to answer'))
    await vi.advanceTimersByTimeAsync(49_999)
    expect(outcome.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const pending = (outcome.value as Extract<PollOutcome<string>, { done: false }>).pending
    expect(pending).toEqual({
      status: 'pending',
      waitId: expect.stringMatching(/^w_[0-9a-f]+$/) as unknown,
      message: 'Still waiting for the user to answer. Call wait_for(waitId) to keep waiting.'
    })
    expect(waits.size).toBe(1)
  })

  it('wait resolves with the final result once the work finishes, then forgets the id', async () => {
    const waits = new WaitRegistry()
    const work = deferred<{ answer: string }>()
    const first = track(waits.run(work.promise, 'the brain'))
    await vi.advanceTimersByTimeAsync(50_000)
    const waitId = (first.value as Extract<PollOutcome<unknown>, { done: false }>).pending.waitId

    const second = track(waits.wait(waitId))
    await vi.advanceTimersByTimeAsync(10_000)
    work.resolve({ answer: 'yes' })
    await vi.advanceTimersByTimeAsync(0)
    expect(second.value).toEqual({ done: true, value: { answer: 'yes' } })
    expect(waits.size).toBe(0)
    expect(() => waits.wait(waitId)).toThrow(BridgeToolError)
  })

  it('wait answers pending again, with the same id, after another 50 s', async () => {
    const waits = new WaitRegistry()
    const first = track(waits.run(new Promise<string>(() => undefined), 'the user'))
    await vi.advanceTimersByTimeAsync(50_000)
    const waitId = (first.value as Extract<PollOutcome<unknown>, { done: false }>).pending.waitId

    const again = track(waits.wait(waitId))
    await vi.advanceTimersByTimeAsync(49_999)
    expect(again.settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(again.value).toMatchObject({ done: false, pending: { status: 'pending', waitId } })
  })

  it('passes the work error on, from the call or from wait_for', async () => {
    const waits = new WaitRegistry()
    const quick = track(waits.run(Promise.reject(new BridgeToolError('nope', 'No.')), 'x'))
    await vi.advanceTimersByTimeAsync(0)
    expect(quick.error).toMatchObject({ code: 'nope' })

    const work = deferred<string>()
    const first = track(waits.run(work.promise, 'x'))
    await vi.advanceTimersByTimeAsync(50_000)
    const waitId = (first.value as Extract<PollOutcome<unknown>, { done: false }>).pending.waitId
    work.reject(new BridgeToolError('late', 'Too late.'))
    const later = track(waits.wait(waitId))
    await vi.advanceTimersByTimeAsync(0)
    expect(later.error).toMatchObject({ code: 'late' })
  })

  it('fails an unknown waitId with unknown_wait_id', () => {
    expect(() => new WaitRegistry().wait('w_nope')).toThrow(
      expect.objectContaining({ code: 'unknown_wait_id' }) as Error
    )
  })

  it('clear forgets every pending call', async () => {
    const waits = new WaitRegistry()
    const first = track(waits.run(new Promise<string>(() => undefined), 'x'))
    await vi.advanceTimersByTimeAsync(50_000)
    const waitId = (first.value as Extract<PollOutcome<unknown>, { done: false }>).pending.waitId
    waits.clear()
    expect(() => waits.wait(waitId)).toThrow(BridgeToolError)
  })
})
