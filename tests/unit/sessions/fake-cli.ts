import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AgentAdapter } from '../../../src/main/agents/agent-adapter'
import { ClaudeAdapter } from '../../../src/main/agents/claude-adapter'
import { ProcessSupervisor } from '../../../src/main/agents/process-supervisor'

const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const scenarios = resolve('tests/e2e/fixtures/claude-scenarios')

/** One line of the fake CLI's `FAKE_CLAUDE_LOG`. */
export interface LogRecord {
  argv?: string[]
  stdin?: unknown
  mcpResult?: { tool: string; isError: boolean; text: string }
  shell?: { cmd: string; code: number; out: string }
  permission?: { tool_name: string; input: unknown; behavior: string; message?: string }
}

export function records(logPath: string): LogRecord[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogRecord)
}

/** The real adapter running the fake CLI with a scenario folder (brain.jsonl, worker-<slug>.jsonl). */
export function fakeAdapter(scenario: string, logPath: string): AgentAdapter {
  const real = new ClaudeAdapter({
    supervisor: new ProcessSupervisor(),
    binary: process.execPath,
    binaryArgs: [fake],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    timings: { stopGraceMs: 3000, stopTermMs: 500, interruptAckMs: 500, sigintMs: 500, termMs: 500 }
  })
  const adapter: AgentAdapter = {
    provider: 'claude',
    start: (o) =>
      real.start({
        ...o,
        extraEnv: {
          ...o.extraEnv,
          ELECTRON_RUN_AS_NODE: '1',
          FAKE_CLAUDE_SCRIPT_DIR: join(scenarios, scenario),
          FAKE_CLAUDE_LOG: logPath
        }
      }),
    resume: (o) => adapter.start(o)
  }
  return adapter
}
