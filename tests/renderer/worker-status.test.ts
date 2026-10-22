import { expect, it } from 'vitest'
import {
  STEPPABLE,
  canStepIn,
  controlLabel
} from '../../src/renderer/src/lib/components/sessions/worker-status'
import type { WorkerStatus } from '../../src/shared/types/session'

const ALL: WorkerStatus[] = [
  'queued',
  'starting',
  'working',
  'needs_approval',
  'has_question',
  'done',
  'merged',
  'failed',
  'stopped'
]

it('STEPPABLE is exactly the in-progress statuses', () => {
  expect([...STEPPABLE]).toEqual(['starting', 'working', 'needs_approval', 'has_question'])
})

it('canStepIn is true only for steppable statuses', () => {
  for (const status of ALL) {
    expect(canStepIn({ status, role: 'worker', userControl: null })).toBe(
      STEPPABLE.includes(status)
    )
  }
})

it('canStepIn excludes resolvers and workers already controlled', () => {
  expect(canStepIn({ status: 'working', role: 'resolver', userControl: null })).toBe(false)
  expect(canStepIn({ status: 'working', role: 'worker', userControl: 'active' })).toBe(false)
  expect(canStepIn({ status: 'working', role: 'worker', userControl: 'paused' })).toBe(false)
  expect(canStepIn({ status: 'working', role: 'worker' })).toBe(true)
})

it('controlLabel names active and paused control, else null', () => {
  expect(controlLabel({ userControl: 'active' })).toBe("You're in control")
  expect(controlLabel({ userControl: 'paused' })).toBe("You're in control (paused)")
  expect(controlLabel({ userControl: null })).toBeNull()
  expect(controlLabel({})).toBeNull()
})
