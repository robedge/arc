import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import {
  claudeWindowLabel,
  createClaudeParser,
  utilizationToPercent
} from '../../../src/main/agents/claude-parser'
import { createCodexParser } from '../../../src/main/agents/codex/codex-parser'
import { codexWindowLabel } from '../../../src/main/agents/codex/codex-types'
import type { JsonObject } from '../../../src/main/agents/codex/codex-types'

type RateLimit = Extract<AgentEvent, { type: 'rate-limit' }>

function claudeLimits(lines: string[]): RateLimit[] {
  const parser = createClaudeParser({ agentId: 'brain', now: () => 1 })
  return lines
    .flatMap((l) => parser.parse(l))
    .filter((e): e is RateLimit => e.type === 'rate-limit')
}

function fixtureLines(name: string): string[] {
  return readFileSync(resolve('tests/fixtures/claude/2.1.302', name), 'utf8')
    .split('\n')
    .filter(Boolean)
}

function limitLine(info: Record<string, unknown>): string {
  return JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info })
}

describe('claude rate-limit windows', () => {
  it('plan-check fixture: five_hour 0.05 and seven_day 0.28 become 5 and 28 percent', () => {
    const [event, ...rest] = claudeLimits(fixtureLines('plan-check.jsonl'))
    expect(rest).toEqual([])
    expect(event).toMatchObject({ provider: 'claude', status: 'allowed', resetsAt: 1792518000 })
    expect(event?.windows).toEqual([
      { windowId: 'five_hour', label: '5h', usedPercent: 5, resetsAt: 1792518000 },
      { windowId: 'seven_day', label: 'Weekly', usedPercent: 28, resetsAt: 1792810800 }
    ])
  })

  it('text-turn fixture: the older event shape yields windows too', () => {
    const [event] = claudeLimits(fixtureLines('text-turn.jsonl'))
    expect(event?.status).toBe('allowed')
    expect(event?.windows?.map((w) => w.windowId)).toEqual(['five_hour', 'seven_day'])
    expect(event?.windows?.[0]?.usedPercent).toBeCloseTo(2, 5)
  })

  it('a value above 1.5 is already a percentage; results are clamped to 0-100', () => {
    expect(utilizationToPercent(0.79)).toBeCloseTo(79, 5)
    expect(utilizationToPercent(1)).toBe(100)
    expect(utilizationToPercent(1.5)).toBe(100)
    expect(utilizationToPercent(42)).toBe(42)
    expect(utilizationToPercent(250)).toBe(100)
    expect(utilizationToPercent(-0.2)).toBe(0)
  })

  it('humanizes other window keys and takes null/absent resets as null', () => {
    expect(claudeWindowLabel('five_hour')).toBe('5h')
    expect(claudeWindowLabel('seven_day')).toBe('Weekly')
    expect(claudeWindowLabel('seven_day_opus')).toBe('Seven day opus')
    const [event] = claudeLimits([
      limitLine({
        status: 'allowed',
        unifiedWindows: {
          seven_day_opus: { utilization: 80 },
          five_hour: { utilization: 0.1, resetsAt: null }
        }
      })
    ])
    expect(event?.windows).toEqual([
      { windowId: 'seven_day_opus', label: 'Seven day opus', usedPercent: 80, resetsAt: null },
      { windowId: 'five_hour', label: '5h', usedPercent: 10, resetsAt: null }
    ])
  })

  it('an event without unifiedWindows keeps status and resetsAt and has no windows', () => {
    const [event] = claudeLimits([limitLine({ status: 'rejected', resetsAt: 77 })])
    expect(event).toMatchObject({ status: 'rejected', resetsAt: 77 })
    expect(event?.windows).toBeUndefined()
  })
})

describe('codex rate-limit windows', () => {
  function updated(rateLimits: JsonObject): RateLimit {
    const parser = createCodexParser({ agentId: 'w1', now: () => 1 })
    const event = parser
      .parse('account/rateLimits/updated', { rateLimits })
      .find((e): e is RateLimit => e.type === 'rate-limit')
    if (!event) throw new Error('no rate-limit event')
    return event
  }

  it('real-turn recording: the weekly primary window and the plan type', () => {
    const lines = readFileSync(resolve('tests/fixtures/codex/0.162.1/real-turn.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { dir: string; msg?: { method?: string; params?: JsonObject } })
    const parser = createCodexParser({ agentId: 'w1', now: () => 1 })
    const limits = lines
      .filter((l) => l.dir === 's2c' && l.msg?.method !== undefined)
      .flatMap((l) => parser.parse(l.msg?.method ?? '', l.msg?.params ?? {}))
      .filter((e): e is RateLimit => e.type === 'rate-limit')
    expect(limits.length).toBeGreaterThan(0)
    expect(limits[0]).toMatchObject({
      status: 'allowed',
      resetsAt: 1792887685,
      planType: 'pro',
      windows: [{ windowId: 'codex:10080', label: 'Weekly', usedPercent: 0, resetsAt: 1792887685 }]
    })
  })

  it('primary and secondary become windows named by their duration', () => {
    const event = updated({
      primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 100 },
      secondary: { usedPercent: 30.5, windowDurationMins: 10080, resetsAt: 200 },
      planType: 'plus'
    })
    expect(event.windows).toEqual([
      { windowId: 'codex:300', label: '5h', usedPercent: 12, resetsAt: 100 },
      { windowId: 'codex:10080', label: 'Weekly', usedPercent: 30.5, resetsAt: 200 }
    ])
    expect(event.planType).toBe('plus')
  })

  it('labels other durations and has no windows when both are null', () => {
    expect(codexWindowLabel(60)).toBe('1h')
    expect(codexWindowLabel(1440)).toBe('1d')
    expect(codexWindowLabel(43200)).toBe('30d')
    expect(codexWindowLabel(45)).toBe('45m')
    const none = updated({ primary: null, secondary: null })
    expect(none.windows).toBeUndefined()
    expect(none.planType).toBeUndefined()
    expect(none.status).toBe('allowed')
  })

  it('a missing resetsAt is null; status/resetsAt for the gate are unchanged', () => {
    const event = updated({
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 7 },
      rateLimitReachedType: 'primary'
    })
    expect(event).toMatchObject({ status: 'rejected', resetsAt: 7 })
    expect(
      updated({ primary: { usedPercent: 1, windowDurationMins: 300 } }).windows?.[0]?.resetsAt
    ).toBeNull()
  })
})
