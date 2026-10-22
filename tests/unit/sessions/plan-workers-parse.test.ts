import { describe, expect, it } from 'vitest'
import { parsePlanWorkers } from '../../../src/main/sessions/plan-coordinator'

const base = { name: 'a', task: 't', repos: [], model: null, rationale: 'r' }

describe('parsePlanWorkers provider normalization', () => {
  it('reads a legacy worker as claude', () => {
    const [w] = parsePlanWorkers(
      JSON.stringify([{ ...base, model: 'opus', approvedModel: 'opus' }])
    )
    expect(w).toMatchObject({ provider: 'claude', approvedProvider: 'claude' })
  })

  it('keeps codex and falls back approvedProvider to provider', () => {
    const [w] = parsePlanWorkers(
      JSON.stringify([{ ...base, provider: 'codex', approvedModel: 'gpt-5' }])
    )
    expect(w).toMatchObject({ provider: 'codex', approvedProvider: 'codex' })
  })

  it('treats an unknown provider as claude and omits approvedProvider before approval', () => {
    const [w] = parsePlanWorkers(JSON.stringify([{ ...base, provider: 'zzz' }]))
    expect(w?.provider).toBe('claude')
    expect(w).not.toHaveProperty('approvedProvider')
  })
})
