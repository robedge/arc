import { READ_PATH_MAX } from '../agent-events'
import type { AgentErrorKind, AgentEvent, UsageBuckets } from '../agent-events'
import {
  agentDeltaSchema,
  codexRateLimitWindows,
  commandItemSchema,
  errorNotificationSchema,
  fileChangeItemSchema,
  itemNotificationSchema,
  mcpItemSchema,
  mcpStartupSchema,
  planUpdatedSchema,
  rateLimitsSchema,
  reroutedSchema,
  tokenUsageSchema,
  turnNotificationSchema,
  type CodexItem,
  type CodexTokenCounts,
  type JsonObject
} from './codex-types'
import { unwrapShell } from './codex-normalize'

/**
 * Turns one `codex app-server` notification into normalized events. Pure and stateful only for
 * the items it has seen. Schemas are loose, and nothing here throws: a notification it cannot read
 * becomes an `unknown` event.
 */

const SUMMARY_MAX = 120
/** A tool result's text is kept up to this many characters (the terminal shows the first lines). */
const RESULT_TEXT_MAX = 16_384

/** Notifications that carry nothing Arc needs, so they produce no event at all. */
const SILENT = new Set([
  'thread/started',
  'thread/status/changed',
  'turn/diff/updated',
  'serverRequest/resolved',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta'
])

/** Item types that are not tool calls and are handled (or skipped) on their own. */
const NOT_TOOLS = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'reasoning',
  'plan',
  'functionCallOutput',
  'contextCompaction',
  'sleep',
  'enteredReviewMode',
  'exitedReviewMode'
])

const FAILED_STATUSES = new Set(['failed', 'declined'])

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine
}

function cap(text: string): string {
  return text.length > RESULT_TEXT_MAX ? text.slice(0, RESULT_TEXT_MAX) : text
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** The first short string argument of an MCP call, for the one-line summary. */
function argsSummary(args: unknown): string {
  const record = asRecord(args)
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return truncate(value)
  }
  return ''
}

/** Maps Codex's `codexErrorInfo` to the error kinds the consumers know. */
export function errorKindOf(info: unknown): AgentErrorKind {
  if (typeof info === 'string') {
    if (info === 'unauthorized') return 'auth'
    if (['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'].includes(info)) {
      return 'rate-limit'
    }
    return 'api'
  }
  return 'api'
}

export interface CodexParserOptions {
  agentId: string
  now?: () => number
  /** Where "last disagrees with the delta of total" is reported. Silent when absent. */
  debug?: (message: string, detail: unknown) => void
}

/** Codex's raw counters; `inputTokens` includes the cached and cache-write tokens. */
interface RawCounts {
  input: number
  cached: number
  cacheWrite: number
  output: number
}

const rawCounts = (c: CodexTokenCounts): RawCounts => ({
  input: c.inputTokens ?? 0,
  cached: c.cachedInputTokens ?? 0,
  cacheWrite: c.cacheWriteInputTokens ?? 0,
  output: c.outputTokens ?? 0
})

const sameCounts = (a: RawCounts, b: RawCounts): boolean =>
  a.input === b.input &&
  a.cached === b.cached &&
  a.cacheWrite === b.cacheWrite &&
  a.output === b.output

/** Codex counters to the four non-overlapping buckets. Reasoning is assumed to sit inside output. */
function bucketsOf(c: RawCounts): UsageBuckets {
  return {
    input: Math.max(0, c.input - c.cached - c.cacheWrite),
    cacheWrite: c.cacheWrite,
    cacheRead: c.cached,
    output: c.output
  }
}

export interface CodexParser {
  parse(method: string, params: JsonObject): AgentEvent[]
  /** The last `item/started` (or `item/completed`) seen for this item id. */
  item(itemId: string): CodexItem | undefined
  /** The MCP tool call of `server` that started most recently and has not completed. */
  activeMcpCall(server: string): CodexItem | undefined
}

export function createCodexParser(options: CodexParserOptions): CodexParser {
  const now = options.now ?? Date.now
  const { agentId } = options
  /** Per thread: the last cumulative `total` seen, and whether its first request was reported. */
  const threads = new Map<string, { prevTotal?: RawCounts; firstSent: boolean }>()
  const items = new Map<string, CodexItem>()
  const announced = new Set<string>()
  const thinkingSeen = new Set<string>()
  const failedTurns = new Set<string>()
  const openMcpCalls: CodexItem[] = []

  const unknown = (method: string, params: JsonObject): AgentEvent[] => [
    { type: 'unknown', agentId, ts: now(), raw: { method, params } }
  ]

  function commandSummary(item: CodexItem): string {
    const parsed = commandItemSchema.safeParse(item)
    const command = parsed.success ? (parsed.data.command ?? '') : ''
    const script = unwrapShell(command)
    return script === '' ? 'Bash' : `Bash: ${truncate(script)}`
  }

  function fileSummary(item: CodexItem): string {
    const parsed = fileChangeItemSchema.safeParse(item)
    const paths = parsed.success ? (parsed.data.changes ?? []).map((c) => c.path) : []
    if (paths.length === 0) return 'Edit'
    const noun = paths.length === 1 ? 'file' : 'files'
    return `Edit: ${truncate(`${paths.length} ${noun}: ${paths.join(', ')}`)}`
  }

  /** The tool name and one-line summary an item shows as, or undefined when it is not a tool call. */
  function toolFor(item: CodexItem): { name: string; summary: string } | undefined {
    if (NOT_TOOLS.has(item.type)) return undefined
    if (item.type === 'commandExecution') return { name: 'Bash', summary: commandSummary(item) }
    if (item.type === 'fileChange') return { name: 'Edit', summary: fileSummary(item) }
    if (item.type === 'mcpToolCall') {
      const parsed = mcpItemSchema.safeParse(item)
      if (!parsed.success) return { name: 'mcp', summary: 'mcp' }
      const name = `mcp:${parsed.data.server}.${parsed.data.tool}`
      const args = argsSummary(parsed.data.arguments)
      return { name, summary: args === '' ? name : `${name}: ${args}` }
    }
    const record = asRecord(item)
    const detail = [record['query'], record['tool'], record['path']].find(
      (v): v is string => typeof v === 'string' && v !== ''
    )
    return { name: item.type, summary: detail ? `${item.type}: ${truncate(detail)}` : item.type }
  }

  function resultFor(item: CodexItem): { isError: boolean; content: string } {
    if (item.type === 'commandExecution') {
      const parsed = commandItemSchema.safeParse(item)
      if (!parsed.success) return { isError: false, content: '' }
      const { status, exitCode, aggregatedOutput } = parsed.data
      const failed = FAILED_STATUSES.has(status ?? '') || (exitCode != null && exitCode !== 0)
      return { isError: failed, content: cap(aggregatedOutput ?? '') }
    }
    if (item.type === 'fileChange') {
      const parsed = fileChangeItemSchema.safeParse(item)
      if (!parsed.success) return { isError: false, content: '' }
      const lines = (parsed.data.changes ?? []).map((c) => `${c.kind?.type ?? 'change'} ${c.path}`)
      return {
        isError: FAILED_STATUSES.has(parsed.data.status ?? ''),
        content: cap(lines.join('\n'))
      }
    }
    if (item.type === 'mcpToolCall') {
      const parsed = mcpItemSchema.safeParse(item)
      if (!parsed.success) return { isError: false, content: '' }
      const { status, error, result } = parsed.data
      const errorText = typeof error === 'string' ? error : (error?.message ?? '')
      const text = (result?.content ?? []).map((c) => c.text ?? '').join('')
      const failed = FAILED_STATUSES.has(status ?? '') || (error != null && error !== '')
      return { isError: failed, content: cap(failed && errorText !== '' ? errorText : text) }
    }
    const record = asRecord(item)
    return {
      isError: FAILED_STATUSES.has(typeof record['status'] === 'string' ? record['status'] : ''),
      content: ''
    }
  }

  /** The file a `commandExecution` reads, from its first `read` action (a command that reads several counts the first). */
  function readPathOfCommand(item: CodexItem): string | undefined {
    if (item.type !== 'commandExecution') return undefined
    const parsed = commandItemSchema.safeParse(item)
    if (!parsed.success) return undefined
    const path = parsed.data.commandActions?.find(
      (a) => a.type === 'read' && typeof a.path === 'string' && a.path !== ''
    )?.path
    return path !== undefined && path.length <= READ_PATH_MAX ? path : undefined
  }

  function toolUse(item: CodexItem): AgentEvent[] {
    if (announced.has(item.id)) return []
    const tool = toolFor(item)
    if (!tool) return []
    announced.add(item.id)
    const readPath = readPathOfCommand(item)
    return [
      {
        type: 'tool-use',
        agentId,
        ts: now(),
        toolUseId: item.id,
        name: tool.name,
        summary: tool.summary,
        ...(readPath === undefined ? {} : { readPath })
      }
    ]
  }

  function onItemStarted(params: JsonObject): AgentEvent[] {
    const parsed = itemNotificationSchema.safeParse(params)
    if (!parsed.success) return unknown('item/started', params)
    const item = parsed.data.item as CodexItem
    items.set(item.id, item)
    if (item.type === 'mcpToolCall') openMcpCalls.push(item)
    return toolUse(item)
  }

  function closeMcpCall(id: string): void {
    const at = openMcpCalls.findIndex((c) => c.id === id)
    if (at >= 0) openMcpCalls.splice(at, 1)
  }

  function onItemCompleted(params: JsonObject): AgentEvent[] {
    const parsed = itemNotificationSchema.safeParse(params)
    if (!parsed.success) return unknown('item/completed', params)
    const item = parsed.data.item as CodexItem
    items.set(item.id, item)
    closeMcpCall(item.id)
    if (item.type === 'agentMessage') {
      const text = typeof item['text'] === 'string' ? item['text'] : ''
      return text === ''
        ? []
        : [{ type: 'assistant-message', agentId, ts: now(), messageId: item.id, text }]
    }
    if (item.type === 'reasoning') {
      if (thinkingSeen.has(item.id)) return []
      const summary = Array.isArray(item['summary']) ? (item['summary'] as unknown[]) : []
      const text = summary.filter((s): s is string => typeof s === 'string').join('\n')
      return text === ''
        ? []
        : [{ type: 'thinking-delta', agentId, ts: now(), messageId: item.id, text }]
    }
    if (item.type === 'plan') return []
    // An item first seen at completion (no `item/started`) still shows as a call and its result.
    const events = toolUse(item)
    if (!announced.has(item.id)) return events
    const result = resultFor(item)
    events.push({
      type: 'tool-result',
      agentId,
      ts: now(),
      toolUseId: item.id,
      isError: result.isError,
      ...(result.content === '' ? {} : { content: result.content })
    })
    return events
  }

  function onTurnStarted(params: JsonObject): AgentEvent[] {
    const parsed = turnNotificationSchema.safeParse(params)
    if (!parsed.success) return unknown('turn/started', params)
    return [{ type: 'turn-started', agentId, ts: now(), turnId: parsed.data.turn.id }]
  }

  function onTurnCompleted(params: JsonObject): AgentEvent[] {
    const parsed = turnNotificationSchema.safeParse(params)
    if (!parsed.success) return unknown('turn/completed', params)
    const { turn } = parsed.data
    const status =
      turn.status === 'interrupted'
        ? 'interrupted'
        : turn.status === 'failed'
          ? 'failed'
          : 'completed'
    const events: AgentEvent[] = []
    // The `error` notification normally comes first; a failed turn that never sent one still reports why.
    if (status === 'failed' && !failedTurns.has(turn.id) && turn.error?.message) {
      events.push({
        type: 'error',
        agentId,
        ts: now(),
        kind: errorKindOf(turn.error.codexErrorInfo),
        message: turn.error.message
      })
    }
    failedTurns.delete(turn.id)
    events.push({
      type: 'turn-result',
      agentId,
      ts: now(),
      ok: status === 'completed',
      interrupted: status === 'interrupted',
      durationMs: turn.durationMs ?? 0,
      turnId: turn.id,
      status
    })
    return events
  }

  function onError(params: JsonObject): AgentEvent[] {
    const parsed = errorNotificationSchema.safeParse(params)
    if (!parsed.success) return unknown('error', params)
    if (parsed.data.willRetry === true) return []
    const turnId = params['turnId']
    if (typeof turnId === 'string') failedTurns.add(turnId)
    return [
      {
        type: 'error',
        agentId,
        ts: now(),
        kind: errorKindOf(parsed.data.error.codexErrorInfo),
        message: parsed.data.error.message
      }
    ]
  }

  /**
   * One `thread/tokenUsage/updated` is one finished request. Its spend is the delta of the cumulative
   * `total` against the previous update of the thread, which keeps a re-sent update from counting
   * twice (zero delta: no event at all). With no previous total (first update, or a resumed thread
   * whose counter is seeded) or a counter that went backwards, `last` is the spend. If `last`
   * disagrees with the delta (a missed update), the delta is trusted and the gap is logged.
   */
  function onUsage(params: JsonObject): AgentEvent[] {
    const parsed = tokenUsageSchema.safeParse(params)
    if (!parsed.success) return unknown('thread/tokenUsage/updated', params)
    const { total, last, modelContextWindow } = parsed.data.tokenUsage
    const state = threads.get(parsed.data.threadId ?? '') ?? { firstSent: false }
    threads.set(parsed.data.threadId ?? '', state)
    const lastRaw = rawCounts(last)
    let spend = lastRaw
    if (total) {
      const current = rawCounts(total)
      const prev = state.prevTotal
      state.prevTotal = current
      const forward =
        prev !== undefined &&
        current.input >= prev.input &&
        current.cached >= prev.cached &&
        current.cacheWrite >= prev.cacheWrite &&
        current.output >= prev.output
      if (prev !== undefined && forward) {
        spend = {
          input: current.input - prev.input,
          cached: current.cached - prev.cached,
          cacheWrite: current.cacheWrite - prev.cacheWrite,
          output: current.output - prev.output
        }
        if (!sameCounts(spend, lastRaw)) {
          options.debug?.(
            'codex token usage: last differs from the delta of total; using the delta',
            {
              delta: spend,
              last: lastRaw
            }
          )
        }
      }
    }
    if (spend.input + spend.output === 0) return []
    const buckets = bucketsOf(spend)
    const lastBuckets = bucketsOf(lastRaw)
    const turnId = parsed.data.turnId
    const event: AgentEvent = {
      type: 'usage',
      agentId,
      ts: now(),
      scope: 'turn',
      ...buckets,
      maxCallInput: lastRaw.input,
      callCount: 1,
      partial: false
    }
    if (turnId !== undefined) event.turnId = turnId
    if (typeof modelContextWindow === 'number') event.contextWindow = modelContextWindow
    if (!state.firstSent) {
      state.firstSent = true
      event.firstCall = {
        input: lastBuckets.input,
        cacheWrite: lastBuckets.cacheWrite,
        cacheRead: lastBuckets.cacheRead
      }
    }
    return [event]
  }

  function onRateLimits(params: JsonObject): AgentEvent[] {
    const parsed = rateLimitsSchema.safeParse(params)
    if (!parsed.success) return unknown('account/rateLimits/updated', params)
    const { primary, planType, rateLimitReachedType } = parsed.data.rateLimits
    const reached = rateLimitReachedType !== null && rateLimitReachedType !== undefined
    const event: AgentEvent = {
      type: 'rate-limit',
      agentId,
      ts: now(),
      provider: 'codex',
      status: reached ? 'rejected' : 'allowed'
    }
    if (typeof primary?.resetsAt === 'number') event.resetsAt = primary.resetsAt
    const windows = codexRateLimitWindows(parsed.data.rateLimits)
    if (windows.length > 0) event.windows = windows
    if (typeof planType === 'string' && planType !== '') event.planType = planType
    return [event]
  }

  function onDelta(params: JsonObject, kind: 'text-delta' | 'thinking-delta'): AgentEvent[] {
    const parsed = agentDeltaSchema.safeParse(params)
    if (!parsed.success) return unknown(kind, params)
    if (parsed.data.delta === '') return []
    if (kind === 'thinking-delta') thinkingSeen.add(parsed.data.itemId)
    return [
      { type: kind, agentId, ts: now(), messageId: parsed.data.itemId, text: parsed.data.delta }
    ]
  }

  function parse(method: string, params: JsonObject): AgentEvent[] {
    if (SILENT.has(method)) return []
    switch (method) {
      case 'item/started':
        return onItemStarted(params)
      case 'item/completed':
        return onItemCompleted(params)
      case 'item/agentMessage/delta':
        return onDelta(params, 'text-delta')
      case 'item/reasoning/summaryTextDelta':
        return onDelta(params, 'thinking-delta')
      case 'turn/started':
        return onTurnStarted(params)
      case 'turn/completed':
        return onTurnCompleted(params)
      case 'thread/tokenUsage/updated':
        return onUsage(params)
      case 'account/rateLimits/updated':
        return onRateLimits(params)
      case 'error':
        return onError(params)
      case 'turn/plan/updated': {
        const parsed = planUpdatedSchema.safeParse(params)
        if (!parsed.success) return unknown(method, params)
        return [
          {
            type: 'plan-updated',
            agentId,
            ts: now(),
            items: parsed.data.plan.map((p) => ({ text: p.step, status: p.status }))
          }
        ]
      }
      case 'model/rerouted': {
        const parsed = reroutedSchema.safeParse(params)
        if (!parsed.success) return unknown(method, params)
        return [
          {
            type: 'model-rerouted',
            agentId,
            ts: now(),
            from: parsed.data.fromModel,
            to: parsed.data.toModel
          }
        ]
      }
      case 'mcpServer/startupStatus/updated': {
        const parsed = mcpStartupSchema.safeParse(params)
        if (!parsed.success) return unknown(method, params)
        return [
          {
            type: 'mcp-status',
            agentId,
            ts: now(),
            name: parsed.data.name,
            status: parsed.data.status
          }
        ]
      }
      default:
        // turn/moderationMetadata, thread/settings/updated, account/updated and anything newer.
        return unknown(method, params)
    }
  }

  return {
    parse(method, params) {
      try {
        return parse(method, params)
      } catch {
        return unknown(method, params)
      }
    },
    item: (itemId) => items.get(itemId),
    activeMcpCall: (server) => {
      for (let i = openMcpCalls.length - 1; i >= 0; i--) {
        const call = openMcpCalls[i]
        if (call && call['server'] === server) return call
      }
      return undefined
    }
  }
}
