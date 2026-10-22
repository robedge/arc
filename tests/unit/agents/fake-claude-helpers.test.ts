import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createClaudeParser } from '../../../src/main/agents/claude-parser'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
let tmp: string | undefined

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  tmp = undefined
})

describe('fake-claude helper steps', () => {
  it('plays a first result before the task notification, then a second turn and result', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'arc-fake-helpers-'))
    const script = join(tmp, 's.jsonl')
    const steps = [
      { init: true },
      { taskStart: { id: 'a', description: 'Check types' } },
      { taskStart: { id: 'b', description: 'Check lint' } },
      { taskTool: { id: 'a', name: 'Bash', input: { command: 'pnpm typecheck' } } },
      { taskSay: { id: 'a', text: 'Types are fine.' } },
      { say: 'Started two helpers.' },
      { result: true },
      { taskEnd: { id: 'a' } },
      { taskEnd: { id: 'b' } },
      { say: 'Both helpers finished.' },
      { result: true }
    ]
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
    const events = out.split('\n').flatMap((l) => parser.parse(l))
    const trace = events
      // usage events are covered by the parser tests; this trace is about the helper steps
      .filter((e) => e.type !== 'session' && e.type !== 'usage' && e.type !== 'usage-progress')
      .map((e) => {
        if (e.type === 'tasks-changed') return `running:${e.running}`
        if (e.type === 'task-started') return `started:${e.description}`
        if (e.type === 'task-ended') return `ended:${e.taskId}`
        if (e.type === 'turn-result') return 'result'
        if (e.type === 'tool-use') return `tool:${e.name}${e.parentToolUseId ? '(helper)' : ''}`
        if (e.type === 'assistant-message') return `say${e.parentToolUseId ? '(helper)' : ''}`
        return e.type
      })
    expect(trace).toEqual([
      'tool:Agent',
      'running:1',
      'started:Check types',
      'tool-result',
      'tool:Agent',
      'running:2',
      'started:Check lint',
      'tool-result',
      'tool:Bash(helper)',
      'tool-result',
      'say(helper)',
      'say',
      'result',
      'ended:task_a',
      'running:1',
      'ended:task_b',
      'running:0',
      'say',
      'result'
    ])
  })
})
