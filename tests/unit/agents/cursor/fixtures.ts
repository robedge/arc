import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createCursorParser } from '../../../../src/main/agents/cursor/cursor-parser'
import {
  permissionParamsSchema,
  type CursorApprovalRequest
} from '../../../../src/main/agents/cursor/cursor-types'

/** The recorded Cursor ACP fixtures (CLI 2026.10.19-6bbf2c4), scrubbed. */
const dir = resolve('tests/fixtures/cursor/2026.10.19-6bbf2c4')

export interface FixtureLine {
  dir: string
  t?: number
  msg?: Record<string, unknown>
}

export function readFixture(name: string): FixtureLine[] {
  return readFileSync(resolve(dir, name), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as FixtureLine)
}

/** What Cursor sent, in order: responses, notifications and server requests. */
export function serverMessages(name: string): Record<string, unknown>[] {
  return readFixture(name).flatMap((l) => (l.dir === 's2c' && l.msg ? [l.msg] : []))
}

/** The `session/update` and `session/request_permission` messages after the `session/prompt` request. */
export function turnMessages(name: string): Record<string, unknown>[] {
  const lines = readFixture(name)
  const promptAt = lines.findIndex((l) => l.dir === 'c2s' && l.msg?.['method'] === 'session/prompt')
  return lines.slice(promptAt + 1).flatMap((l) => (l.dir === 's2c' && l.msg ? [l.msg] : []))
}

/** The `session/new` answer Cursor gave. */
export function sessionNewResult(name: string): Record<string, unknown> {
  const lines = readFixture(name)
  const idAt = lines.find((l) => l.dir === 'c2s' && l.msg?.['method'] === 'session/new')?.msg?.[
    'id'
  ]
  const reply = lines.find((l) => l.dir === 's2c' && l.msg?.['id'] === idAt)
  return (reply?.msg?.['result'] ?? {}) as Record<string, unknown>
}

/**
 * The permission requests of a recorded turn, built as the adapter builds them: each with the
 * `tool_call` (and its updates) the parser had seen when the request arrived.
 */
export function approvalRequests(name: string): CursorApprovalRequest[] {
  const parser = createCursorParser({ agentId: 'w1' })
  const out: CursorApprovalRequest[] = []
  for (const msg of serverMessages(name)) {
    const method = String(msg['method'] ?? '')
    const params = (msg['params'] ?? {}) as Record<string, unknown>
    if (method === 'session/update') parser.parse(method, params)
    if (method !== 'session/request_permission') continue
    const parsed = permissionParamsSchema.parse(params)
    parser.markAsked(parsed.toolCall.toolCallId)
    const tool = parser.toolCall(parsed.toolCall.toolCallId)
    out.push({
      agentId: 'w1',
      sessionId: 'session-1',
      requestId: msg['id'] as number,
      toolCallId: parsed.toolCall.toolCallId,
      title: parsed.toolCall.title ?? '',
      kind: parsed.toolCall.kind ?? 'other',
      options: parsed.options,
      raw: params,
      ...(tool ? { tool } : {})
    })
  }
  return out
}

/**
 * What Cursor sent after each `session/prompt` request, one list per prompt, the prompt's own answer
 * (the message with a `result` and the prompt's id) last. `proc` limits it to one process of a
 * two-process recording (M4).
 */
export function promptTurns(name: string, proc?: string): Record<string, unknown>[][] {
  const turns: Record<string, unknown>[][] = []
  let promptId: unknown
  for (const l of readFixture(name)) {
    if (proc !== undefined && (l as { proc?: string }).proc !== proc) continue
    if (l.dir === 'c2s' && l.msg?.['method'] === 'session/prompt') {
      promptId = l.msg['id']
      turns.push([])
    } else if (l.dir === 's2c' && l.msg && turns.length > 0) {
      turns[turns.length - 1]?.push(l.msg)
      if (l.msg['id'] === promptId && 'result' in l.msg) promptId = undefined
    }
  }
  return turns
}

/** What Cursor sent between the `session/load` request and its answer (the replay), then the answer. */
export function loadReplay(
  name: string,
  proc: string
): { replay: Record<string, unknown>[]; result: Record<string, unknown> } {
  const lines = readFixture(name).filter((l) => (l as { proc?: string }).proc === proc)
  const at = lines.findIndex((l) => l.dir === 'c2s' && l.msg?.['method'] === 'session/load')
  const id = lines[at]?.msg?.['id']
  const replay: Record<string, unknown>[] = []
  for (const l of lines.slice(at + 1)) {
    if (l.dir !== 's2c' || !l.msg) continue
    if (l.msg['id'] === id) {
      return { replay, result: (l.msg['result'] ?? {}) as Record<string, unknown> }
    }
    replay.push(l.msg)
  }
  throw new Error('the fixture has no session/load answer')
}
