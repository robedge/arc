import type { z } from 'zod'
import { READ_PATH_MAX } from '../agent-events'
import type { AgentEvent } from '../agent-events'
import {
  availableCommandsSchema,
  planUpdateSchema,
  sessionUpdateParamsSchema,
  textChunkSchema,
  toolCallUpdateSchema,
  type CursorCommand,
  type CursorToolCall,
  type JsonObject
} from './cursor-types'

/**
 * Turns the `session/update` notifications of `agent acp` into normalized events. Stateful for the
 * turn in progress and the tool calls seen. Schemas are loose, and nothing here throws: an update
 * it cannot read becomes an `unknown` event.
 *
 * Cursor sends text in word-sized chunks with no message id, so the parser assembles the assistant
 * message itself: a message ends at the next tool call or at the end of the turn.
 */

const SUMMARY_MAX = 120
/** A tool result's text is kept up to this many characters (the terminal shows the first lines). */
const RESULT_TEXT_MAX = 16_384
/** An assistant text this short, alone in its turn, can be the plan-limit refusal. */
const LIMIT_TEXT_MAX = 300

/** Updates that carry nothing Arc needs, so they produce no event. */
const SILENT = new Set([
  'session_info_update',
  'current_mode_update',
  'config_option_update',
  'user_message_chunk'
])

/** Plan and entitlement limits and rate limits, in the words Cursor and its providers use. */
const LIMIT_WORDS =
  /upgrade your plan|usage limit|rate[ -]limit|quota|out of (?:credits|usage)|\b429\b|too many requests|limit (?:reached|exceeded)/i

/**
 * True for text that reports a plan or rate limit: a JSON-RPC error message, stderr, a stop reason
 * or an assistant message. The plan block of a Free account arrives as the assistant text "Upgrade
 * your plan to continue" with `end_turn` and no error (spike M1).
 */
export function isCursorLimitError(text: string): boolean {
  return LIMIT_WORDS.test(text)
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine
}

type Buckets = { input: number; cacheWrite: number; cacheRead: number; output: number }

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * The four token buckets of an ACP `usage` object, or undefined when it names none. Cursor's ACP
 * reports no tokens today (spike M1), so this is defensive: it reads the field names of the ACP
 * schema (`cachedReadTokens`) and the ones Cursor's own types use (`cacheReadTokens`). `inputTokens`
 * is the uncached input; thought tokens count as output.
 */
export function cursorUsageBuckets(value: unknown): Buckets | undefined {
  const usage = asRecord(value)
  const input = count(usage['inputTokens'])
  const output = count(usage['outputTokens'])
  const cacheRead = count(usage['cacheReadTokens']) ?? count(usage['cachedReadTokens'])
  const cacheWrite = count(usage['cacheWriteTokens']) ?? count(usage['cachedWriteTokens'])
  if (
    input === undefined &&
    output === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  )
    return undefined
  return {
    input: input ?? 0,
    cacheWrite: cacheWrite ?? 0,
    cacheRead: cacheRead ?? 0,
    output: (output ?? 0) + (count(usage['thoughtTokens']) ?? 0)
  }
}

function cap(text: string): string {
  return text.length > RESULT_TEXT_MAX ? text.slice(0, RESULT_TEXT_MAX) : text
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The first short string argument of an MCP call, for the one-line summary. */
function argsSummary(args: unknown): string {
  for (const value of Object.values(asRecord(args))) {
    if (typeof value === 'string' && value.trim() !== '') return truncate(value)
  }
  return ''
}

/** The tool name each ACP kind shows as, matching the names the Claude and Codex parsers use. */
const KIND_NAMES: Readonly<Record<string, string>> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  execute: 'Bash',
  search: 'Search',
  fetch: 'WebFetch',
  think: 'Think',
  switch_mode: 'Mode'
}

/** The server and tool of an MCP call, from `rawInput` (known only after the first `tool_call_update`). */
function mcpIdentity(call: CursorToolCall): { server: string; tool: string } | undefined {
  const server = str(call.rawInput['providerIdentifier'])
  const tool = str(call.rawInput['toolName'])
  return server !== '' && tool !== '' ? { server, tool } : undefined
}

type ToolUpdate = z.infer<typeof toolCallUpdateSchema>

export type CursorTurnOutcome =
  /** `session/prompt` answered. */
  | { stopReason: string; usage?: unknown }
  /** `session/prompt` failed (a JSON-RPC error, or the process ended). */
  | { error: string }

export interface CursorParserOptions {
  agentId: string
  now?: () => number
  /**
   * Called once for each tool call that completes (or fails) without a permission request having
   * named it. The call carries what the classifier needs (kind, input, output, timestamps).
   */
  onUnasked?: (call: CursorToolCall) => void
}

export interface CursorParser {
  /** A prompt is about to be sent: `turn-started`, and a fresh message and tool state for the turn. */
  beginTurn(): AgentEvent[]
  /** One `session/update` (any other method becomes an `unknown` event). */
  parse(method: string, params: JsonObject): AgentEvent[]
  /**
   * The prompt ended: the pending message, then the turn's `usage` when Cursor reported tokens, then
   * the `turn-result` (a plan-limit turn adds a `rate-limit` error first).
   */
  endTurn(outcome: CursorTurnOutcome): AgentEvent[]
  /** The tool call as seen so far; the approvals read the command and paths from it. */
  toolCall(toolCallId: string): CursorToolCall | undefined
  /** A permission request named this call. */
  markAsked(toolCallId: string): void
  /** The latest `available_commands_update`, for the command probe. */
  availableCommands(): CursorCommand[]
}

export function createCursorParser(options: CursorParserOptions): CursorParser {
  const now = options.now ?? Date.now
  const { agentId } = options
  // Message and turn ids must not repeat across a resume: the consumers remember the ids they saw.
  const idPrefix = `c${now().toString(36)}`
  const tools = new Map<string, CursorToolCall>()
  const announced = new Set<string>()
  const resulted = new Set<string>()
  const finished = new Set<string>()
  let commands: CursorCommand[] = []

  let turnSeq = 0
  let turnId = ''
  let turnStartedAt = now()
  let messageSeq = 0
  let message: { id: string; text: string } | undefined
  let thoughtSeq = 0
  let thoughtId: string | undefined
  /** Tool calls in this turn, to recognise the plan-limit refusal (it has none). */
  let turnTools = 0
  /** The latest running total of this turn from a `usage_update`; the turn's usage if the response has none. */
  let runningUsage: Buckets | undefined

  const unknown = (method: string, params: JsonObject): AgentEvent[] => [
    { type: 'unknown', agentId, ts: now(), raw: { method, params } }
  ]

  function flushMessage(): AgentEvent[] {
    const pending = message
    message = undefined
    if (!pending || pending.text.trim() === '') return []
    return [
      { type: 'assistant-message', agentId, ts: now(), messageId: pending.id, text: pending.text }
    ]
  }

  function onText(update: JsonObject, kind: 'text-delta' | 'thinking-delta'): AgentEvent[] {
    const parsed = textChunkSchema.safeParse(update)
    if (!parsed.success) return unknown('session/update', update)
    const text = parsed.data.content.text ?? ''
    if (text === '') return []
    if (kind === 'thinking-delta') {
      thoughtId ??= `${idPrefix}-t${++thoughtSeq}`
      return [{ type: kind, agentId, ts: now(), messageId: thoughtId, text }]
    }
    thoughtId = undefined
    message ??= { id: `${idPrefix}-m${++messageSeq}`, text: '' }
    message.text += text
    return [{ type: kind, agentId, ts: now(), messageId: message.id, text }]
  }

  function toolFor(call: CursorToolCall): { name: string; summary: string } {
    const mcp = mcpIdentity(call)
    if (mcp) {
      // Named as Claude names MCP tools, so the terminal and the worker status treat Arc's bridge tools as plumbing.
      const name = `mcp__${mcp.server}__${mcp.tool}`
      const args = argsSummary(call.rawInput['args'])
      return { name, summary: args === '' ? name : `${name}: ${args}` }
    }
    const name = KIND_NAMES[call.kind] ?? (call.title.replace(/\s+/g, ' ').trim() || 'Tool')
    let raw: string
    if (call.kind === 'execute') raw = str(call.rawInput['command'])
    else if (call.kind === 'read' || call.kind === 'edit' || call.kind === 'delete') {
      raw = call.locations[0] ?? str(call.rawInput['path'])
    } else raw = call.title
    const detail = truncate(raw)
    return { name, summary: detail === '' || detail === name ? name : `${name}: ${detail}` }
  }

  function readPathOf(call: CursorToolCall): string | undefined {
    if (call.kind !== 'read') return undefined
    const path = call.locations[0] ?? str(call.rawInput['path'])
    return path !== '' && path.length <= READ_PATH_MAX ? path : undefined
  }

  /**
   * A call is shown once it says what it is. An `edit` and an MCP call start with an empty
   * `rawInput` and a generic title; the path or the server and tool arrive in the next update.
   */
  function ready(call: CursorToolCall): boolean {
    return call.status !== 'pending' || Object.keys(call.rawInput).length > 0
  }

  function announce(call: CursorToolCall): AgentEvent[] {
    if (announced.has(call.toolCallId) || !ready(call)) return []
    announced.add(call.toolCallId)
    const tool = toolFor(call)
    const readPath = readPathOf(call)
    return [
      {
        type: 'tool-use',
        agentId,
        ts: now(),
        toolUseId: call.toolCallId,
        name: tool.name,
        summary: tool.summary,
        ...(readPath === undefined ? {} : { readPath })
      }
    ]
  }

  function resultOf(call: CursorToolCall): { isError: boolean; content: string } {
    const out = call.rawOutput
    if (out) {
      const error = out['error']
      if (typeof error === 'string' && error !== '') return { isError: true, content: cap(error) }
      if (call.kind === 'execute') {
        const exitCode = typeof out['exitCode'] === 'number' ? out['exitCode'] : 0
        const text = [str(out['stdout']), str(out['stderr'])].filter((s) => s !== '').join('\n')
        return { isError: exitCode !== 0, content: cap(text) }
      }
      if (typeof out['content'] === 'string')
        return { isError: false, content: cap(out['content']) }
    }
    const diffs = call.content
      .map(asRecord)
      .filter((c) => c['type'] === 'diff')
      .map((c) => `edit ${str(c['path'])}`)
    if (diffs.length > 0) return { isError: false, content: cap(diffs.join('\n')) }
    if (out && call.kind === 'other') {
      return { isError: false, content: cap(JSON.stringify(out)) }
    }
    return { isError: false, content: '' }
  }

  function applyUpdate(call: CursorToolCall, update: ToolUpdate): void {
    if (update.title !== undefined && update.title !== '') call.title = update.title
    if (update.kind !== undefined && update.kind !== '') call.kind = update.kind
    if (update.rawInput && Object.keys(update.rawInput).length > 0) call.rawInput = update.rawInput
    if (update.rawOutput) call.rawOutput = update.rawOutput
    if (update.locations) {
      const paths = update.locations.map((l) => l.path ?? '').filter((p) => p !== '')
      if (paths.length > 0) call.locations = paths
    }
    if (update.content) call.content = update.content
    if (update.status !== undefined && update.status !== call.status) {
      call.status = update.status
      if (update.status === 'in_progress') call.inProgressAt = now()
      if (update.status === 'completed' || update.status === 'failed') call.completedAt = now()
    }
  }

  function onToolCall(update: JsonObject): AgentEvent[] {
    const parsed = toolCallUpdateSchema.safeParse(update)
    if (!parsed.success) return unknown('session/update', update)
    const events = flushMessage() // the next message starts after any tool call
    thoughtId = undefined
    turnTools += 1
    const call: CursorToolCall = {
      toolCallId: parsed.data.toolCallId,
      title: '',
      kind: 'other',
      status: 'pending',
      rawInput: {},
      locations: [],
      content: [],
      permissionAsked: false,
      startedAt: now()
    }
    tools.set(call.toolCallId, call)
    applyUpdate(call, parsed.data)
    return [...events, ...announce(call)]
  }

  function onToolCallUpdate(update: JsonObject): AgentEvent[] {
    const parsed = toolCallUpdateSchema.safeParse(update)
    if (!parsed.success) return unknown('session/update', update)
    const call = tools.get(parsed.data.toolCallId)
    if (!call) return unknown('session/update', update)
    applyUpdate(call, parsed.data)
    const events = announce(call)
    if (
      (call.status === 'completed' || call.status === 'failed') &&
      !finished.has(call.toolCallId)
    ) {
      finished.add(call.toolCallId)
      if (!call.permissionAsked) {
        try {
          options.onUnasked?.(call)
        } catch {
          // a note that cannot be made never breaks the stream
        }
      }
    }
    if (
      (call.status === 'completed' || call.status === 'failed') &&
      announced.has(call.toolCallId) &&
      !resulted.has(call.toolCallId)
    ) {
      resulted.add(call.toolCallId)
      const result = resultOf(call)
      events.push({
        type: 'tool-result',
        agentId,
        ts: now(),
        toolUseId: call.toolCallId,
        isError: result.isError || call.status === 'failed',
        ...(result.content === '' ? {} : { content: result.content })
      })
    }
    return events
  }

  function parseUpdate(params: JsonObject): AgentEvent[] {
    const parsed = sessionUpdateParamsSchema.safeParse(params)
    if (!parsed.success) return unknown('session/update', params)
    const update = parsed.data.update as JsonObject
    const kind = parsed.data.update.sessionUpdate
    if (SILENT.has(kind)) return []
    switch (kind) {
      case 'agent_message_chunk':
        return onText(update, 'text-delta')
      case 'agent_thought_chunk':
        return onText(update, 'thinking-delta')
      case 'tool_call':
        return onToolCall(update)
      case 'tool_call_update':
        return onToolCallUpdate(update)
      case 'available_commands_update': {
        const list = availableCommandsSchema.safeParse(update)
        if (!list.success) return unknown('session/update', params)
        commands = list.data.availableCommands.map((c) => ({
          name: c.name,
          description: c.description ?? ''
        }))
        return []
      }
      case 'usage_update': {
        const usage = cursorUsageBuckets(update['usage'] ?? asRecord(update['_meta'])['usage'])
        if (usage === undefined) return []
        runningUsage = usage
        return [{ type: 'usage-progress', agentId, ts: now(), turnId, ...usage, callCount: 1 }]
      }
      case 'plan': {
        const plan = planUpdateSchema.safeParse(update)
        if (!plan.success) return unknown('session/update', params)
        return [
          {
            type: 'plan-updated',
            agentId,
            ts: now(),
            items: plan.data.entries.map((e) => ({
              text: e.content,
              status: e.status ?? 'pending'
            }))
          }
        ]
      }
      default:
        return unknown('session/update', params)
    }
  }

  function turnResult(
    status: 'completed' | 'interrupted' | 'failed'
  ): Extract<AgentEvent, { type: 'turn-result' }> {
    return {
      type: 'turn-result',
      agentId,
      ts: now(),
      ok: status === 'completed',
      interrupted: status === 'interrupted',
      durationMs: Math.max(0, now() - turnStartedAt),
      turnId,
      status
    }
  }

  const errorEvent = (kind: 'rate-limit' | 'api', text: string): AgentEvent => ({
    type: 'error',
    agentId,
    ts: now(),
    kind,
    message: text
  })

  function endTurn(outcome: CursorTurnOutcome): AgentEvent[] {
    // The plan block of a Free account: one short refusal text, no tool call, `end_turn`, no error.
    const limitText = message?.text ?? ''
    const planBlocked =
      'stopReason' in outcome &&
      outcome.stopReason === 'end_turn' &&
      turnTools === 0 &&
      limitText.trim().length <= LIMIT_TEXT_MAX &&
      isCursorLimitError(limitText)
    let events: AgentEvent[]
    if (planBlocked) {
      message = undefined
      events = [errorEvent('rate-limit', limitText.trim())]
    } else {
      events = flushMessage()
    }
    let result: Extract<AgentEvent, { type: 'turn-result' }>
    if (planBlocked) {
      result = turnResult('failed')
    } else if ('error' in outcome) {
      events.push(
        errorEvent(isCursorLimitError(outcome.error) ? 'rate-limit' : 'api', outcome.error)
      )
      result = turnResult('failed')
    } else if (outcome.stopReason === 'end_turn') {
      result = turnResult('completed')
    } else if (outcome.stopReason === 'cancelled') {
      result = turnResult('interrupted')
    } else {
      events.push(errorEvent('api', `Cursor stopped the turn: ${outcome.stopReason}.`))
      result = turnResult('failed')
    }
    const usage =
      ('stopReason' in outcome ? cursorUsageBuckets(outcome.usage) : undefined) ?? runningUsage
    if (usage !== undefined) {
      events.push({
        type: 'usage',
        agentId,
        ts: now(),
        scope: 'turn',
        turnId,
        ...usage,
        maxCallInput: usage.input + usage.cacheWrite + usage.cacheRead,
        callCount: 1,
        partial: false
      })
    }
    events.push(result)
    return events
  }

  return {
    beginTurn() {
      turnSeq += 1
      turnId = `${idPrefix}-turn${turnSeq}`
      turnStartedAt = now()
      message = undefined
      thoughtId = undefined
      turnTools = 0
      runningUsage = undefined
      return [{ type: 'turn-started', agentId, ts: now(), turnId }]
    },
    parse(method, params) {
      try {
        return method === 'session/update' ? parseUpdate(params) : unknown(method, params)
      } catch {
        return unknown(method, params)
      }
    },
    endTurn(outcome) {
      try {
        return endTurn(outcome)
      } catch {
        return [turnResult('failed')]
      }
    },
    toolCall: (id) => tools.get(id),
    markAsked(id) {
      const call = tools.get(id)
      if (call) call.permissionAsked = true
    },
    availableCommands: () => commands
  }
}
