import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentEvent } from '../../../src/main/agents/agent-events'
import { createClaudeParser } from '../../../src/main/agents/claude-parser'

const lines = readFileSync(
  resolve('tests/fixtures/claude/2.1.302/subagent-background.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean)

function parseAll(): AgentEvent[] {
  const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
  return lines.flatMap((line) => parser.parse(line))
}

function ofType<T extends AgentEvent['type']>(
  events: AgentEvent[],
  type: T
): Extract<AgentEvent, { type: T }>[] {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type)
}

const AGENT_CALL = 'toolu_01Wud955na5FnxGNFuQms4DL'
const TASK = 'ab24089c3593e5ddc'

describe('claude-parser: background helper agents (recorded stream)', () => {
  const events = parseAll()

  it('reads system/task_started', () => {
    expect(ofType(events, 'task-started')).toEqual([
      {
        type: 'task-started',
        agentId: 'w',
        ts: 1,
        taskId: TASK,
        toolUseId: AGENT_CALL,
        description: 'Run node multiplication check',
        backgrounded: true
      }
    ])
  })

  it('reads background_tasks_changed as the authoritative list, before and after the helper', () => {
    const changed = ofType(events, 'tasks-changed')
    expect(changed).toHaveLength(2)
    expect(changed[0]).toMatchObject({
      running: 1,
      tasks: [{ taskId: TASK, description: 'Run node multiplication check' }]
    })
    expect(changed[1]).toMatchObject({ running: 0, tasks: [] })
  })

  it('reports the end once, although task_updated and task_notification both announce it', () => {
    const ended = ofType(events, 'task-ended')
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ taskId: TASK, status: 'completed' })
  })

  it('task_updated alone with a terminal status ends the helper; a non-terminal patch does not', () => {
    const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
    expect(
      parser.parse(
        '{"type":"system","subtype":"task_updated","task_id":"t","patch":{"status":"running"}}'
      )
    ).toEqual([])
    expect(
      parser.parse(
        '{"type":"system","subtype":"task_updated","task_id":"t","patch":{"status":"killed"}}'
      )
    ).toMatchObject([{ type: 'task-ended', taskId: 't', status: 'killed' }])
  })

  it('carries parent_tool_use_id on the helper tool use, result and message only', () => {
    const toolUses = ofType(events, 'tool-use')
    expect(toolUses.find((t) => t.name === 'Agent')?.parentToolUseId).toBeUndefined()
    const helperBash = toolUses.find((t) => t.name === 'Bash')
    expect(helperBash).toMatchObject({ parentToolUseId: AGENT_CALL, summary: expect.any(String) })
    const results = ofType(events, 'tool-result')
    expect(results.find((r) => r.toolUseId === AGENT_CALL)?.parentToolUseId).toBeUndefined()
    expect(results.find((r) => r.content === '42')?.parentToolUseId).toBe(AGENT_CALL)
    const messages = ofType(events, 'assistant-message')
    const helperMessage = messages.find((m) => m.text.startsWith('The command ran'))
    expect(helperMessage?.parentToolUseId).toBe(AGENT_CALL)
    expect(
      messages.find((m) => m.text.startsWith("I've launched"))?.parentToolUseId
    ).toBeUndefined()
  })

  it('shows the first result before the helper ends and a second one after', () => {
    const types = events.map((e) => e.type)
    const firstResult = types.indexOf('turn-result')
    const ended = types.indexOf('task-ended')
    const secondResult = types.lastIndexOf('turn-result')
    expect(firstResult).toBeGreaterThan(-1)
    expect(firstResult).toBeLessThan(ended)
    expect(ended).toBeLessThan(secondResult)
  })

  it('task_progress and unknown system lines stay ignored', () => {
    const parser = createClaudeParser({ agentId: 'w', now: () => 1 })
    expect(parser.parse('{"type":"system","subtype":"task_progress","task_id":"t"}')).toEqual([])
  })
})
