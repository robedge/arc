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

async function play(steps: object[]): Promise<AgentEvent[]> {
  tmp = mkdtempSync(join(tmpdir(), 'arc-fake-usage-'))
  const script = join(tmp, 's.jsonl')
  writeFileSync(script, steps.map((s) => JSON.stringify(s)).join('\n'))
  const child = spawn(process.execPath, [fake, '-p'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FAKE_CLAUDE_SCRIPT: script },
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let out = ''
  child.stdout.on('data', (d: Buffer) => (out += d.toString()))
  child.stdin.end()
  await new Promise((r) => child.on('close', r))
  const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
  return out.split('\n').flatMap((l) => parser.parse(l))
}

describe('fake-claude usage', () => {
  it('gives each turn the documented fixed numbers, per turn and not cumulative', async () => {
    const events = await play([
      { init: true },
      { say: 'one' },
      { tool: { name: 'Read', input: { file_path: 'a.ts' } } },
      { result: true },
      { say: 'two' },
      { result: true }
    ])
    const usage = events.filter((e) => e.type === 'usage')
    // turn 1: requests 1 (the say) and 2 (the tool); the say's thinking+text lines share one id.
    expect(usage[0]).toMatchObject({
      scope: 'turn',
      input: 6,
      cacheWrite: 80,
      cacheRead: 600 + 700,
      output: 40,
      callCount: 2,
      maxCallInput: 3 + 40 + 700,
      partial: false
    })
    // turn 2: one request, numbers back to request 1's
    expect(usage[1]).toMatchObject({
      input: 3,
      cacheWrite: 40,
      cacheRead: 600,
      output: 20,
      callCount: 1
    })
    expect(usage[1]?.firstCall).toBeUndefined()
  })
})

describe('fake-claude setup growth (spec 009)', () => {
  async function firstRequestCacheWrite(
    flags: string[],
    perItem: string | undefined
  ): Promise<number> {
    tmp = mkdtempSync(join(tmpdir(), 'arc-fake-setup-'))
    const script = join(tmp, 's.jsonl')
    writeFileSync(
      script,
      [{ init: true }, { say: 'one' }, { result: true }].map((s) => JSON.stringify(s)).join('\n')
    )
    const child = spawn(process.execPath, [fake, '-p', ...flags], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        FAKE_CLAUDE_SCRIPT: script,
        ...(perItem ? { FAKE_CLAUDE_SETUP_PER_ITEM: perItem } : {})
      },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stdin.end()
    await new Promise((r) => child.on('close', r))
    const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
    const usage = out
      .split('\n')
      .flatMap((l) => parser.parse(l))
      .filter((e) => e.type === 'usage')
    return (usage[0] as { cacheWrite: number }).cacheWrite
  }

  it('adds the knob’s tokens per loaded server and plugin folder to the first request, and nothing by default', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'arc-fake-setup-cfg-'))
    const config = join(tmp, 'mcp.json')
    writeFileSync(config, JSON.stringify({ mcpServers: { arc: {}, figma: {}, trello: {} } }))
    const withTwo = await firstRequestCacheWrite(
      [`--mcp-config=${config}`, '--strict-mcp-config'],
      '1000'
    )
    expect(withTwo).toBe(40 + 2 * 1000)
    expect(
      await firstRequestCacheWrite([`--mcp-config=${config}`, '--strict-mcp-config'], undefined)
    ).toBe(40)
    expect(await firstRequestCacheWrite([], '1000')).toBe(40)
  })
})
