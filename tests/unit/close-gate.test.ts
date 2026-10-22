import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { createCloseGate } from '../../src/main/app/close-gate'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function setup(): {
  gate: ReturnType<typeof createCloseGate>
  emit: Mock<() => void>
  proceed: Mock<() => void>
  event: { preventDefault: Mock<() => void> }
} {
  const emit = vi.fn<() => void>()
  return {
    gate: createCloseGate({ emit, timeoutMs: 2000 }),
    emit,
    proceed: vi.fn<() => void>(),
    event: { preventDefault: vi.fn<() => void>() }
  }
}

it('prevents the first close and asks the renderer to flush', () => {
  const { gate, emit, proceed, event } = setup()
  gate.handleClose(event, proceed)
  expect(event.preventDefault).toHaveBeenCalledOnce()
  expect(emit).toHaveBeenCalledOnce()
  expect(proceed).not.toHaveBeenCalled()
})

it('proceeds when the renderer reports ready, and the second close passes through', () => {
  const { gate, proceed, event } = setup()
  gate.handleClose(event, proceed)
  gate.ready()
  expect(proceed).toHaveBeenCalledOnce()
  const second = { preventDefault: vi.fn() }
  gate.handleClose(second, proceed)
  expect(second.preventDefault).not.toHaveBeenCalled()
  expect(proceed).toHaveBeenCalledOnce()
})

it('proceeds after the timeout when the renderer never replies', () => {
  const { gate, proceed, event } = setup()
  gate.handleClose(event, proceed)
  vi.advanceTimersByTime(1999)
  expect(proceed).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(proceed).toHaveBeenCalledOnce()
})

it('repeated closes while waiting emit once and ready proceeds once', () => {
  const { gate, emit, proceed, event } = setup()
  gate.handleClose(event, proceed)
  gate.handleClose({ preventDefault: vi.fn() }, proceed)
  gate.ready()
  gate.ready()
  vi.advanceTimersByTime(5000)
  expect(emit).toHaveBeenCalledOnce()
  expect(proceed).toHaveBeenCalledOnce()
})

it('lets the close pass through immediately when the renderer cannot flush yet', () => {
  const emit = vi.fn<() => void>()
  const proceed = vi.fn<() => void>()
  const event = { preventDefault: vi.fn<() => void>() }
  const gate = createCloseGate({ emit, timeoutMs: 2000, canFlush: () => false })
  gate.handleClose(event, proceed)
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(emit).not.toHaveBeenCalled()
  expect(gate.isOpen).toBe(true)
  vi.advanceTimersByTime(5000)
  expect(proceed).not.toHaveBeenCalled()
})

it('reports a timeout only when the timer, not the renderer, released the close', () => {
  const onTimeout = vi.fn<() => void>()
  const timedOut = createCloseGate({ emit: vi.fn(), timeoutMs: 2000, onTimeout })
  timedOut.handleClose({ preventDefault: vi.fn() }, vi.fn())
  vi.advanceTimersByTime(2000)
  expect(onTimeout).toHaveBeenCalledOnce()

  const answered = createCloseGate({ emit: vi.fn(), timeoutMs: 2000, onTimeout })
  answered.handleClose({ preventDefault: vi.fn() }, vi.fn())
  answered.ready()
  vi.advanceTimersByTime(5000)
  expect(onTimeout).toHaveBeenCalledOnce()
})
