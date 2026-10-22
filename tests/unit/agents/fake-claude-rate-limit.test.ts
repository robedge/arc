import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { createClaudeParser } from '../../../src/main/agents/claude-parser'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

async function play(steps: object[], env: Record<string, string>): Promise<AgentEvent[]> {
  tmp = mkdtempSync(join(tmpdir(), 'arc-fake-limit-'))
  const script = join(tmp, 's.jsonl')
  writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n'))
  const child = spawn(process.execPath, [fake, '-p'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLAUDE_SCRIPT: script, ...env },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.end()
  await new Promise((r) => child.on('close', r))
  const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
  return out.split('\n').flatMap((l) => parser.parse(l))
}

const percents = (events: AgentEvent[]): number[][] =>
  events.flatMap((e) =>
    e.type === 'rate-limit' ? [(e.windows ?? []).map((w) => w.usedPercent)] : []
  )

describe('fake-claude rate limits', () => {
  const turns = [{ init: true }, { say: 'a' }, { result: true }, { say: 'b' }, { result: true }]

  it('emits no rate_limit_event unless configured', async () => {
    expect(percents(await play(turns, {}))).toEqual([])
  })

  it('FAKE_CLAUDE_RATE_LIMIT as an object: every turn reports the same windows', async () => {
    const events = await play(turns, {
      FAKE_CLAUDE_RATE_LIMIT: '{"five_hour":0.79,"seven_day":0.18}'
    })
    expect(percents(events)).toEqual([
      [79, 18],
      [79, 18]
    ])
    const limit = events.find((e) => e.type === 'rate-limit')
    expect(limit).toMatchObject({ status: 'allowed' })
    expect(limit?.type === 'rate-limit' && limit.windows?.[0]?.label).toBe('5h')
  })

  it('an array is consumed one entry per turn, the last repeating', async () => {
    const events = await play([...turns, { say: 'c' }, { result: true }], {
      FAKE_CLAUDE_RATE_LIMIT: '[{"five_hour":0.1},{"five_hour":0.8,"status":"rejected"}]'
    })
    expect(percents(events)).toEqual([[10], [80], [80]])
    expect(
      events.filter((e) => e.type === 'rate-limit').map((e) => e.type === 'rate-limit' && e.status)
    ).toEqual(['allowed', 'rejected', 'rejected'])
  })

  it('a {"rateLimit"} step emits an event of its own', async () => {
    const events = await play(
      [{ init: true }, { rateLimit: { seven_day: 0.5 } }, { result: true }],
      {}
    )
    expect(percents(events)).toEqual([[50]])
  })
})
