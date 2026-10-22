import { describe, expect, it } from 'vitest'
import { toolsForRole } from '../../../src/main/bridge/tools/registry'
import { bridgeToolDescriptions, estimateSetup } from '../../../src/main/usage/setup-estimator'

describe('estimateSetup', () => {
  it('is ceil(chars / 4) over the instructions and every tool description', () => {
    expect(estimateSetup({ instructions: '', toolDescriptions: [] })).toEqual({
      tokens: 0,
      chars: 0
    })
    expect(estimateSetup({ instructions: 'abcd', toolDescriptions: [] })).toEqual({
      tokens: 1,
      chars: 4
    })
    expect(estimateSetup({ instructions: 'abcde', toolDescriptions: [] })).toEqual({
      tokens: 2,
      chars: 5
    })
    expect(
      estimateSetup({ instructions: 'a'.repeat(10), toolDescriptions: ['bb', 'c'.repeat(5)] })
    ).toEqual({ tokens: 5, chars: 17 })
  })
})

describe('bridgeToolDescriptions', () => {
  it('lists name, description and JSON schema for the role, without request_permission', () => {
    const brain = bridgeToolDescriptions('brain')
    const names = toolsForRole('brain')
      .map((t) => t.name)
      .filter((n) => n !== 'request_permission')
    expect(brain).toHaveLength(names.length)
    const spawn = brain.find((d) => d.startsWith('spawn_worker\n'))
    expect(spawn).toContain('"type":"object"')
    expect(spawn).toContain('"properties"')
    expect(brain.some((d) => d.startsWith('request_permission\n'))).toBe(false)
  })

  it('differs by role: the worker is not shown the brain tools', () => {
    const worker = bridgeToolDescriptions('worker')
    expect(worker.some((d) => d.startsWith('report_done\n'))).toBe(true)
    expect(worker.some((d) => d.startsWith('spawn_worker\n'))).toBe(false)
  })
})
