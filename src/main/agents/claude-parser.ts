import { z } from 'zod'
import type {
  AgentEvent,
  HelperTask,
  McpServerStatus,
  RateLimitWindow,
  UsageBuckets,
  UsageCall
} from './agent-events'
import { READ_PATH_MAX } from './agent-events'

/**
 * Turns one stream-json line from `claude` 2.1.x into normalized events. Schemas are permissive
 * (extra keys pass through) because the CLI adds fields between releases. Nothing here throws.
 *
 * One line can carry several events (an assistant message with text and tool calls, a `result`
 * that is also an auth failure), so `parse` returns an array; an empty array means "ignore".
 */

const SUMMARY_MAX = 120
const SUMMARY_KEYS = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'prompt',
  'note',
  'summary',
  'question'
] as const
/** A tool result's text is kept up to this many characters (the terminal shows the first lines). */
const RESULT_TEXT_MAX = 16_384
/** Deferred-tool lookup the model does before its first MCP call. It is plumbing, not progress. */
const NOISE_TOOLS = new Set(['ToolSearch'])

const envelope = z.looseObject({ type: z.string() })

const initSchema = z.looseObject({
  session_id: z.string(),
  model: z.string().optional(),
  permissionMode: z.string().optional(),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })).optional()
})

const streamSchema = z.looseObject({
  parent_tool_use_id: z.string().nullable().optional(),
  api_message_id: z.string().optional(),
  event: z.looseObject({
    type: z.string(),
    message: z.looseObject({ id: z.string().optional() }).optional(),
    delta: z
      .looseObject({
        type: z.string().optional(),
        text: z.string().optional(),
        thinking: z.string().optional()
      })
      .optional()
  })
})

const blockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional()
})

const tokenCountsSchema = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().optional(),
  cache_creation_input_tokens: z.number().optional()
})

const assistantSchema = z.looseObject({
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    usage: tokenCountsSchema.nullable().optional(),
    content: z.array(blockSchema)
  })
})

const userSchema = z.looseObject({
  parent_tool_use_id: z.string().nullable().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(blockSchema)]) })
})

const resultSchema = z.looseObject({
  subtype: z.string().optional(),
  is_error: z.boolean().optional(),
  result: z.string().optional(),
  duration_ms: z.number().optional(),
  terminal_reason: z.string().optional(),
  api_error_status: z.union([z.number(), z.string(), z.null()]).optional(),
  usage: tokenCountsSchema.nullable().optional(),
  /** Per model, cumulative over the process and including helpers (see `modelDelta`). */
  modelUsage: z
    .record(
      z.string(),
      z.looseObject({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
        contextWindow: z.number().optional()
      })
    )
    .optional()
})

const taskStartedSchema = z.looseObject({
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  description: z.string().optional(),
  is_backgrounded: z.boolean().optional()
})

const taskNotificationSchema = z.looseObject({
  task_id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional()
})

const taskUpdatedSchema = z.looseObject({
  task_id: z.string(),
  patch: z.looseObject({ status: z.string().optional() }).optional()
})

const tasksChangedSchema = z.looseObject({
  tasks: z
    .array(z.looseObject({ task_id: z.string(), description: z.string().optional() }))
    .optional()
})

/** Statuses of `task_updated` that mean the helper is over. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed', 'cancelled', 'stopped'])

const rateLimitSchema = z.looseObject({
  rate_limit_info: z
    .looseObject({
      status: z.string().optional(),
      resetsAt: z.number().optional(),
      unifiedWindows: z
        .record(
          z.string(),
          z.looseObject({
            utilization: z.number().optional(),
            resetsAt: z.number().nullish()
          })
        )
        .nullish()
    })
    .optional()
})

/** "five_hour" -> "5h", "seven_day" -> "Weekly", anything else humanized ("seven_day_opus" -> "Seven day opus"). */
export function claudeWindowLabel(key: string): string {
  if (key === 'five_hour') return '5h'
  if (key === 'seven_day') return 'Weekly'
  const words = key.replace(/[_-]+/g, ' ').trim()
  return words === '' ? key : words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * `utilization` is a 0-1 fraction; a value above 1.5 is taken to be a percentage already. The result
 * is a percentage rounded to two decimals and clamped to 0-100.
 */
export function utilizationToPercent(utilization: number): number {
  const percent = utilization > 1.5 ? utilization : utilization * 100
  // Two decimals: 0.28 * 100 is 28.000000000000004.
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100))
}

const controlResponseSchema = z.looseObject({
  response: z.looseObject({ subtype: z.string(), request_id: z.string() })
})

/** The text of a tool_result `content`: a string, or the text blocks of an array. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, RESULT_TEXT_MAX)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content as unknown[]) {
    if (typeof block !== 'object' || block === null) continue
    const { type, text } = block as { type?: unknown; text?: unknown }
    if (type === 'text' && typeof text === 'string') parts.push(text)
  }
  return parts.join('\n').slice(0, RESULT_TEXT_MAX)
}

type TokenCounts = z.infer<typeof tokenCountsSchema>

function bucketsOf(usage: TokenCounts | null | undefined): UsageBuckets {
  return {
    input: usage?.input_tokens ?? 0,
    cacheWrite: usage?.cache_creation_input_tokens ?? 0,
    cacheRead: usage?.cache_read_input_tokens ?? 0,
    output: usage?.output_tokens ?? 0
  }
}

const callInput = (b: UsageCall): number => b.input + b.cacheWrite + b.cacheRead
const isZero = (b: UsageBuckets): boolean => callInput(b) + b.output === 0

const sumBuckets = (list: readonly UsageBuckets[]): UsageBuckets =>
  list.reduce<UsageBuckets>(
    (sum, b) => ({
      input: sum.input + b.input,
      cacheWrite: sum.cacheWrite + b.cacheWrite,
      cacheRead: sum.cacheRead + b.cacheRead,
      output: sum.output + b.output
    }),
    { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }
  )

/** One top-level request of the turn being accumulated. */
interface CallRecord {
  buckets: UsageBuckets
  model?: string
}

function truncate(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX - 1)}…` : oneLine
}

/** `Bash: echo hi`, `Read: /a/b.ts`, or just the tool name when no argument is worth showing. */
export function summarizeToolUse(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>
    for (const key of SUMMARY_KEYS) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') return `${name}: ${truncate(value)}`
    }
  }
  return name
}

/** A path that names one file: a last segment with an extension and no wildcard or brace. */
function isSingleFilePath(path: string): boolean {
  const last = path.split('/').pop() ?? ''
  return /\.[A-Za-z0-9]+$/.test(last) && !/[*?[\]{}]/.test(path)
}

/**
 * The file a read tool targets. `Read` always does; `Grep` and `Glob` only when their `path` names a
 * single file (a directory or a pattern reads many files, which is not a repeated read).
 */
export function readPathOf(name: string, input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  let path: unknown
  if (name === 'Read') path = record['file_path']
  else if (name === 'Grep' || name === 'Glob') path = record['path']
  else return undefined
  if (typeof path !== 'string' || path.trim() === '' || path.length > READ_PATH_MAX)
    return undefined
  if (name !== 'Read' && !isSingleFilePath(path)) return undefined
  return path
}

export interface ClaudeParser {
  parse(line: string): AgentEvent[]
}

export interface ClaudeParserOptions {
  agentId: string
  now?: () => number
}

export function createClaudeParser(options: ClaudeParserOptions): ClaudeParser {
  const now = options.now ?? Date.now
  const { agentId } = options
  let streamMessageId = ''
  let sawInterruptAck = false
  const noiseToolIds = new Set<string>()
  /**
   * Top-level assistant requests of the turn in progress, by `message.id`. One id repeats per content
   * block with the same usage, so the last write wins. Emptied after each `result`.
   */
  const calls = new Map<string, CallRecord>()
  /** Helper (`parent_tool_use_id`) message ids already reported; each is reported once. */
  const helperIds = new Set<string>()
  /** The process's first top-level request; sent on the first turn usage event, then spent. */
  let firstCall: UsageCall | undefined
  let firstCallSpent = false
  let turnSeq = 0
  /** Identity of the last `usage-progress` sent this turn, so an unchanged total is not sent again. */
  let lastProgress = ''
  /** `modelUsage` as of the previous result, to turn the cumulative figures into this turn's. */
  const prevModelUsage = new Map<string, UsageBuckets>()
  /** Helpers whose end was already reported (task_updated and task_notification both announce it). */
  const endedTasks = new Set<string>()
  const parentOf = (id: string | null | undefined): { parentToolUseId?: string } =>
    typeof id === 'string' && id !== '' ? { parentToolUseId: id } : {}

  const unknown = (raw: unknown): AgentEvent[] => [{ type: 'unknown', agentId, ts: now(), raw }]

  function parseInit(obj: unknown): AgentEvent[] {
    const parsed = initSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const mcpServers: McpServerStatus[] = (parsed.data.mcp_servers ?? []).map((s) => ({
      name: s.name,
      status: s.status
    }))
    const event: AgentEvent = {
      type: 'session',
      agentId,
      ts: now(),
      provider: 'claude',
      providerSessionId: parsed.data.session_id,
      model: parsed.data.model ?? '',
      mcpServers
    }
    if (parsed.data.permissionMode !== undefined) event.permissionMode = parsed.data.permissionMode
    return [event]
  }

  function parseStream(obj: unknown): AgentEvent[] {
    const parsed = streamSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const { event } = parsed.data
    if (event.type === 'message_start') {
      streamMessageId = event.message?.id ?? parsed.data.api_message_id ?? ''
      return []
    }
    if (event.type !== 'content_block_delta' || !event.delta) return []
    const messageId = streamMessageId || parsed.data.api_message_id || ''
    const parent = parentOf(parsed.data.parent_tool_use_id)
    if (event.delta.type === 'text_delta' && event.delta.text) {
      return [
        { type: 'text-delta', agentId, ts: now(), messageId, text: event.delta.text, ...parent }
      ]
    }
    if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
      return [
        {
          type: 'thinking-delta',
          agentId,
          ts: now(),
          messageId,
          text: event.delta.thinking,
          ...parent
        }
      ]
    }
    return []
  }

  /** Records one assistant request. A helper's request is reported at once, the first time its id is seen. */
  function trackRequest(
    id: string,
    usage: TokenCounts,
    model: string | undefined,
    isHelper: boolean
  ): AgentEvent | undefined {
    const buckets = bucketsOf(usage)
    // Zero-token lines are the CLI's synthetic messages (auth failure); they are not requests.
    if (isZero(buckets)) return undefined
    if (isHelper) {
      if (helperIds.has(id)) return undefined
      helperIds.add(id)
      return {
        type: 'usage',
        agentId,
        ts: now(),
        scope: 'helper',
        ...(model === undefined ? {} : { model }),
        ...buckets,
        maxCallInput: callInput(buckets),
        callCount: 1,
        partial: false
      }
    }
    calls.set(id, { buckets, ...(model === undefined ? {} : { model }) })
    if (firstCall === undefined && !firstCallSpent) {
      firstCall = {
        input: buckets.input,
        cacheWrite: buckets.cacheWrite,
        cacheRead: buckets.cacheRead
      }
    }
    return progressEvent()
  }

  /**
   * The running total of the turn's requests, or none when it has not changed since the last one sent
   * (one message id repeats per content block with the same usage).
   */
  function progressEvent(): AgentEvent | undefined {
    const sum = sumBuckets([...calls.values()].map((c) => c.buckets))
    const key = `${calls.size}:${sum.input}:${sum.cacheWrite}:${sum.cacheRead}:${sum.output}`
    if (key === lastProgress) return undefined
    lastProgress = key
    return {
      type: 'usage-progress',
      agentId,
      ts: now(),
      turnId: String(turnSeq + 1),
      ...sum,
      callCount: calls.size
    }
  }

  /**
   * This turn's share of `modelUsage`. The CLI reports it cumulatively for the process (and helpers
   * are inside it), unlike `result.usage`, so the previous result's figures are subtracted. A counter
   * that went backwards (a restart) is taken as is.
   */
  function modelDelta(modelUsage: NonNullable<z.infer<typeof resultSchema>['modelUsage']>): {
    perModel: Record<string, UsageBuckets>
    contextWindows: Map<string, number>
  } {
    const perModel: Record<string, UsageBuckets> = {}
    const contextWindows = new Map<string, number>()
    for (const [name, m] of Object.entries(modelUsage)) {
      const current: UsageBuckets = {
        input: m.inputTokens ?? 0,
        cacheWrite: m.cacheCreationInputTokens ?? 0,
        cacheRead: m.cacheReadInputTokens ?? 0,
        output: m.outputTokens ?? 0
      }
      const prev = prevModelUsage.get(name)
      const backwards =
        prev !== undefined &&
        (current.input < prev.input ||
          current.cacheWrite < prev.cacheWrite ||
          current.cacheRead < prev.cacheRead ||
          current.output < prev.output)
      const base = prev === undefined || backwards ? undefined : prev
      const delta: UsageBuckets = {
        input: current.input - (base?.input ?? 0),
        cacheWrite: current.cacheWrite - (base?.cacheWrite ?? 0),
        cacheRead: current.cacheRead - (base?.cacheRead ?? 0),
        output: current.output - (base?.output ?? 0)
      }
      prevModelUsage.set(name, current)
      if (!isZero(delta)) perModel[name] = delta
      if (m.contextWindow !== undefined) contextWindows.set(name, m.contextWindow)
    }
    return { perModel, contextWindows }
  }

  /** The turn's `usage` event, or none when nothing was spent. Resets the per-turn state. */
  function turnUsage(r: z.infer<typeof resultSchema>): AgentEvent[] {
    turnSeq += 1
    const records = [...calls.values()]
    calls.clear()
    const fromResult = bucketsOf(r.usage)
    const modelDeltas = r.modelUsage ? modelDelta(r.modelUsage) : undefined
    const partial = isZero(fromResult) && records.length > 0
    lastProgress = ''
    const totals: UsageBuckets = partial ? sumBuckets(records.map((c) => c.buckets)) : fromResult
    if (isZero(totals)) return []
    const model =
      [...records].reverse().find((c) => c.model !== undefined)?.model ??
      Object.entries(modelDeltas?.perModel ?? {}).sort(
        (a, b) => callInput(b[1]) + b[1].output - (callInput(a[1]) + a[1].output)
      )[0]?.[0]
    const contextWindow = model === undefined ? undefined : modelDeltas?.contextWindows.get(model)
    const sent = firstCall
    if (sent !== undefined) {
      firstCall = undefined
      firstCallSpent = true
    }
    return [
      {
        type: 'usage',
        agentId,
        ts: now(),
        scope: 'turn',
        turnId: String(turnSeq),
        ...(model === undefined ? {} : { model }),
        ...totals,
        // No assistant lines seen (nothing to measure a request by): the totals are the best bound.
        maxCallInput:
          records.length > 0
            ? Math.max(...records.map((c) => callInput(c.buckets)))
            : callInput(totals),
        callCount: Math.max(1, records.length),
        ...(sent === undefined ? {} : { firstCall: sent }),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(modelDeltas !== undefined && Object.keys(modelDeltas.perModel).length > 0
          ? { perModel: modelDeltas.perModel }
          : {}),
        partial
      }
    ]
  }

  function parseAssistant(obj: unknown): AgentEvent[] {
    const parsed = assistantSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const { id = '', content } = parsed.data.message
    const events: AgentEvent[] = []
    const parent = parentOf(parsed.data.parent_tool_use_id)
    const { usage, model } = parsed.data.message
    if (usage && id !== '') {
      const usageEvent = trackRequest(id, usage, model, parent.parentToolUseId !== undefined)
      if (usageEvent) events.push(usageEvent)
    }
    const text = content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
    if (text !== '')
      events.push({ type: 'assistant-message', agentId, ts: now(), messageId: id, text, ...parent })
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.id || !block.name) continue
      if (NOISE_TOOLS.has(block.name)) {
        noiseToolIds.add(block.id)
        continue
      }
      const readPath = readPathOf(block.name, block.input)
      events.push({
        type: 'tool-use',
        agentId,
        ts: now(),
        toolUseId: block.id,
        name: block.name,
        summary: summarizeToolUse(block.name, block.input),
        ...(readPath === undefined ? {} : { readPath }),
        ...parent
      })
    }
    return events
  }

  function parseUser(obj: unknown): AgentEvent[] {
    const parsed = userSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const { content } = parsed.data.message
    if (typeof content === 'string') return []
    const events: AgentEvent[] = []
    const parent = parentOf(parsed.data.parent_tool_use_id)
    for (const block of content) {
      if (block.type !== 'tool_result' || !block.tool_use_id) continue
      if (noiseToolIds.delete(block.tool_use_id)) continue
      const content = resultText(block.content)
      events.push({
        type: 'tool-result',
        agentId,
        ts: now(),
        toolUseId: block.tool_use_id,
        isError: block.is_error === true,
        ...(content === '' ? {} : { content }),
        ...parent
      })
    }
    return events
  }

  function parseResult(obj: unknown): AgentEvent[] {
    const parsed = resultSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const r = parsed.data
    const interrupted =
      r.terminal_reason === 'aborted_streaming' ||
      (r.subtype === 'error_during_execution' && sawInterruptAck)
    sawInterruptAck = false
    const events: AgentEvent[] = []
    const text = r.result ?? ''
    if (r.is_error === true && !interrupted) {
      if (/not logged in/i.test(text)) {
        events.push({ type: 'error', agentId, ts: now(), kind: 'auth', message: text })
      } else {
        const kind = String(r.api_error_status) === '429' ? 'rate-limit' : 'api'
        events.push({
          type: 'error',
          agentId,
          ts: now(),
          kind,
          message: text || r.subtype || 'The agent reported an error.'
        })
      }
    }
    events.push(...turnUsage(r))
    events.push({
      type: 'turn-result',
      agentId,
      ts: now(),
      ok: r.is_error !== true,
      interrupted,
      durationMs: r.duration_ms ?? 0,
      status: interrupted ? 'interrupted' : r.is_error === true ? 'failed' : 'completed'
    })
    return events
  }

  function parseTaskStarted(obj: unknown): AgentEvent[] {
    const parsed = taskStartedSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    endedTasks.delete(parsed.data.task_id)
    return [
      {
        type: 'task-started',
        agentId,
        ts: now(),
        taskId: parsed.data.task_id,
        toolUseId: parsed.data.tool_use_id ?? '',
        description: parsed.data.description ?? '',
        backgrounded: parsed.data.is_backgrounded === true
      }
    ]
  }

  function taskEnded(taskId: string, status: string, summary?: string): AgentEvent[] {
    if (endedTasks.has(taskId)) return []
    endedTasks.add(taskId)
    const event: AgentEvent = { type: 'task-ended', agentId, ts: now(), taskId, status }
    if (summary !== undefined && summary !== '') event.summary = summary
    return [event]
  }

  function parseTaskNotification(obj: unknown): AgentEvent[] {
    const parsed = taskNotificationSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    return taskEnded(parsed.data.task_id, parsed.data.status ?? 'completed', parsed.data.summary)
  }

  function parseTaskUpdated(obj: unknown): AgentEvent[] {
    const parsed = taskUpdatedSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const status = parsed.data.patch?.status
    return status !== undefined && TERMINAL_TASK_STATUSES.has(status)
      ? taskEnded(parsed.data.task_id, status)
      : []
  }

  function parseTasksChanged(obj: unknown): AgentEvent[] {
    const parsed = tasksChangedSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const tasks: HelperTask[] = (parsed.data.tasks ?? []).map((t) => ({
      taskId: t.task_id,
      description: t.description ?? ''
    }))
    return [{ type: 'tasks-changed', agentId, ts: now(), running: tasks.length, tasks }]
  }

  function parseSystem(obj: unknown): AgentEvent[] {
    // Only `init` and the helper (task) lines matter. hook_*, status, thinking_tokens,
    // commands_changed, task_progress and permission_denied are noise here (a denied tool also
    // yields an is_error tool_result).
    switch ((obj as { subtype?: unknown }).subtype) {
      case 'init':
        return parseInit(obj)
      case 'task_started':
        return parseTaskStarted(obj)
      case 'task_notification':
        return parseTaskNotification(obj)
      case 'task_updated':
        return parseTaskUpdated(obj)
      case 'background_tasks_changed':
        return parseTasksChanged(obj)
      default:
        return []
    }
  }

  function parseRateLimit(obj: unknown): AgentEvent[] {
    const parsed = rateLimitSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const info = parsed.data.rate_limit_info
    const event: AgentEvent = { type: 'rate-limit', agentId, ts: now(), provider: 'claude' }
    if (info?.resetsAt !== undefined) event.resetsAt = info.resetsAt
    if (info?.status !== undefined) event.status = info.status
    const windows: RateLimitWindow[] = []
    for (const [key, w] of Object.entries(info?.unifiedWindows ?? {})) {
      if (w.utilization === undefined) continue
      windows.push({
        windowId: key,
        label: claudeWindowLabel(key),
        usedPercent: utilizationToPercent(w.utilization),
        resetsAt: w.resetsAt ?? null
      })
    }
    if (windows.length > 0) event.windows = windows
    return [event]
  }

  function parseControlResponse(obj: unknown): AgentEvent[] {
    const parsed = controlResponseSchema.safeParse(obj)
    if (!parsed.success) return unknown(obj)
    const { subtype, request_id: requestId } = parsed.data.response
    const ok = subtype === 'success'
    if (ok) sawInterruptAck = true
    return [{ type: 'control-ack', agentId, ts: now(), requestId, ok }]
  }

  return {
    parse(line: string): AgentEvent[] {
      const trimmed = line.trim()
      if (trimmed === '') return []
      let obj: unknown
      try {
        obj = JSON.parse(trimmed)
      } catch {
        return unknown(line)
      }
      const head = envelope.safeParse(obj)
      if (!head.success) return unknown(obj)
      switch (head.data.type) {
        case 'system':
          return parseSystem(obj)
        case 'stream_event':
          return parseStream(obj)
        case 'assistant':
          return parseAssistant(obj)
        case 'user':
          return parseUser(obj)
        case 'result':
          return parseResult(obj)
        case 'rate_limit_event':
          return parseRateLimit(obj)
        case 'control_response':
          return parseControlResponse(obj)
        default:
          return unknown(obj)
      }
    }
  }
}
