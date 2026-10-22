import { describe, expect, it } from 'vitest'
import { deriveListStatus } from '../../../src/main/sessions/list-status'
import type { ListStatusInput } from '../../../src/main/sessions/list-status'

const cases: [string, ListStatusInput, string][] = [
  ['active and thinking', { sessionStatus: 'active', brainState: 'thinking' }, 'working'],
  ['active and idle', { sessionStatus: 'active', brainState: 'idle' }, 'idle'],
  ['stopped', { sessionStatus: 'stopped', brainState: 'idle' }, 'stopped'],
  ['stopped beats thinking', { sessionStatus: 'stopped', brainState: 'thinking' }, 'stopped'],
  ['active worker', { sessionStatus: 'active', brainState: 'idle', activeWorkers: 1 }, 'working'],
  [
    'attention beats working',
    { sessionStatus: 'active', brainState: 'thinking', pendingAttention: 2 },
    'needs-attention'
  ],
  [
    'stopped beats attention',
    { sessionStatus: 'stopped', brainState: 'idle', pendingAttention: 1 },
    'stopped'
  ]
]

describe('deriveListStatus', () => {
  it.each(cases)('%s', (_name, input, expected) => {
    expect(deriveListStatus(input)).toBe(expected)
  })
})
