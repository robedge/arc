import { z } from 'zod'
import type { RateLimitWindow } from '../agent-events'
import type { JsonObject, JsonRpcId } from '../rpc/json-rpc-peer'

/**
 * A hand-written subset of the `codex app-server` protocol (codex-cli 0.162.x, marked experimental).
 * Only the fields Arc reads are listed, and every object is loose because Codex adds fields between
 * releases. The generated schema is not imported; fixtures under `tests/fixtures/codex/` pin the shapes.
 */

/** The oldest app-server these types were checked against. */
export const CODEX_PROTOCOL_VERSION = '0.162.1'

export type { JsonObject, JsonRpcId }

// ---- turn input -----------------------------------------------------------------------------

/** One element of `turn/start.input`: plain text, or a skill to run (`path` is its SKILL.md). */
export type CodexInput =
  { type: 'text'; text: string } | { type: 'skill'; name: string; path: string }

// ---- approvals ------------------------------------------------------------------------------

/** The four server requests that ask Arc for a decision. */
export type CodexApprovalKind = 'command' | 'file-change' | 'permissions' | 'mcp-elicitation'

/**
 * One approval request, as the adapter hands it to the handler. Minimal on purpose: the approvals
 * task turns it into a `NormalizedAction`. `raw` is the request's params exactly as Codex sent them.
 */
export interface CodexApprovalRequest {
  kind: CodexApprovalKind
  /** The app-server method (`item/commandExecution/requestApproval`, ...). */
  method: string
  /** The JSON-RPC id of the request. */
  requestId: JsonRpcId
  agentId: string
  threadId: string
  turnId: string
  /** The request's params. */
  raw: JsonObject
  /** The item (`commandExecution`, `fileChange`, `mcpToolCall`) that raised it, when Codex announced it first. */
  item?: CodexItem
}

/**
 * What the handler decides.
 * - `accept`: run this one action.
 * - `decline`: refuse it; the turn continues.
 * - `cancel`: refuse it and end the turn.
 *
 * The adapter only ever answers with these three. It never grants for the session, never adds an
 * execpolicy amendment and never uses `scope: 'session'`.
 */
export interface CodexApprovalDecision {
  decision: 'accept' | 'decline' | 'cancel'
  /**
   * Why, when the decision is a `decline`. The adapter steers it into the running turn before it
   * answers (`[Arc] <message>`), because the decline response itself carries no text. Best effort.
   */
  message?: string
}

/**
 * The `signal.reason` when Codex withdrew the request (the turn was interrupted, or the server
 * resolved it). When the process ended or Arc stopped it, the signal aborts without this reason:
 * the request is only lost, and can be answered again after a resume.
 */
export const APPROVAL_WITHDRAWN = 'withdrawn'

export interface ApprovalHandler {
  /**
   * Decides one request. `signal` aborts when Codex withdraws the request (the turn was interrupted
   * or the process ended); the answer is then dropped.
   */
  handle(request: CodexApprovalRequest, signal: AbortSignal): Promise<CodexApprovalDecision>
}

// ---- items ----------------------------------------------------------------------------------

/** A thread item (`item/started`, `item/completed`). Loose: each type has its own extra fields. */
export const itemSchema = z.looseObject({ type: z.string(), id: z.string() })
export type CodexItem = z.infer<typeof itemSchema> & Record<string, unknown>

export const itemNotificationSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  item: itemSchema
})

export const commandItemSchema = z.looseObject({
  command: z.string().optional(),
  /** What the command does, as Codex classifies it; a `read` action names the file it reads. */
  commandActions: z
    .array(z.looseObject({ type: z.string(), path: z.string().optional() }))
    .optional(),
  status: z.string().optional(),
  aggregatedOutput: z.string().nullable().optional(),
  exitCode: z.number().nullable().optional()
})

export const fileChangeItemSchema = z.looseObject({
  status: z.string().optional(),
  changes: z
    .array(
      z.looseObject({
        path: z.string(),
        kind: z.looseObject({ type: z.string().optional() }).optional()
      })
    )
    .optional()
})

export const mcpItemSchema = z.looseObject({
  server: z.string(),
  tool: z.string(),
  status: z.string().optional(),
  arguments: z.unknown().optional(),
  readOnlyHint: z.boolean().nullable().optional(),
  result: z
    .looseObject({
      content: z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() }))
    })
    .nullable()
    .optional(),
  error: z
    .union([z.string(), z.looseObject({ message: z.string().optional() })])
    .nullable()
    .optional()
})

// ---- notifications --------------------------------------------------------------------------

export const turnSchema = z.looseObject({
  id: z.string(),
  status: z.string().optional(),
  durationMs: z.number().nullable().optional(),
  error: z
    .looseObject({ message: z.string().optional(), codexErrorInfo: z.unknown().optional() })
    .nullable()
    .optional()
})
export type CodexTurn = z.infer<typeof turnSchema>

export const turnNotificationSchema = z.looseObject({
  threadId: z.string().optional(),
  turn: turnSchema
})

export const agentDeltaSchema = z.looseObject({ itemId: z.string(), delta: z.string() })

const tokenCountsSchema = z.looseObject({
  totalTokens: z.number().optional(),
  inputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningOutputTokens: z.number().optional()
})
export type CodexTokenCounts = z.infer<typeof tokenCountsSchema>

/**
 * `total` is cumulative for the thread, `last` is the one request that just finished. `inputTokens`
 * includes the cached tokens.
 */
export const tokenUsageSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  tokenUsage: z.looseObject({
    total: tokenCountsSchema.optional(),
    last: tokenCountsSchema,
    modelContextWindow: z.number().nullable().optional()
  })
})

const rateLimitWindowSchema = z
  .looseObject({
    usedPercent: z.number().optional(),
    windowDurationMins: z.number().nullish(),
    resetsAt: z.number().nullish()
  })
  .nullish()

/** The `rateLimits` object of `account/rateLimits/updated` and of the `account/rateLimits/read` answer. */
export const rateLimitSnapshotSchema = z.looseObject({
  primary: rateLimitWindowSchema,
  secondary: rateLimitWindowSchema,
  planType: z.string().nullish(),
  rateLimitReachedType: z.unknown().optional()
})

export const rateLimitsSchema = z.looseObject({ rateLimits: rateLimitSnapshotSchema })

/** 300 is "5h", 10080 is "Weekly", otherwise "<N>h" / "<N>d" (and "<N>m" under an hour). */
export function codexWindowLabel(mins: number): string {
  if (mins === 300) return '5h'
  if (mins === 10080) return 'Weekly'
  if (mins < 60) return `${Math.max(1, Math.round(mins))}m`
  if (mins < 1440) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

/** The windows of one snapshot (`primary` then `secondary`); a window without a duration or percent is skipped. */
export function codexRateLimitWindows(
  snapshot: z.infer<typeof rateLimitSnapshotSchema>
): RateLimitWindow[] {
  const windows: RateLimitWindow[] = []
  for (const w of [snapshot.primary, snapshot.secondary]) {
    if (!w || typeof w.usedPercent !== 'number' || typeof w.windowDurationMins !== 'number')
      continue
    windows.push({
      windowId: `codex:${w.windowDurationMins}`,
      label: codexWindowLabel(w.windowDurationMins),
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt ?? null
    })
  }
  return windows
}

export const errorNotificationSchema = z.looseObject({
  error: z.looseObject({ message: z.string(), codexErrorInfo: z.unknown().optional() }),
  willRetry: z.boolean().optional()
})

export const planUpdatedSchema = z.looseObject({
  plan: z.array(z.looseObject({ step: z.string(), status: z.string() }))
})

export const reroutedSchema = z.looseObject({ fromModel: z.string(), toModel: z.string() })

export const mcpStartupSchema = z.looseObject({ name: z.string(), status: z.string() })

// ---- server requests ------------------------------------------------------------------------

export const approvalParamsSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  itemId: z.string().optional()
})

export const elicitationParamsSchema = z.looseObject({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  serverName: z.string().optional(),
  message: z.string().optional(),
  _meta: z.looseObject({ codex_approval_kind: z.string().optional() }).nullable().optional()
})

// ---- requests the client sends --------------------------------------------------------------

export const threadResponseSchema = z.looseObject({
  thread: z.looseObject({ id: z.string(), model: z.string().optional() }),
  model: z.string().optional()
})

export const turnStartResponseSchema = z.looseObject({ turn: z.looseObject({ id: z.string() }) })

export const initializeResponseSchema = z.looseObject({ userAgent: z.string().optional() })

export const accountResponseSchema = z.looseObject({
  account: z.looseObject({ type: z.string().optional() }).nullable().optional(),
  requiresOpenaiAuth: z.boolean().optional()
})
