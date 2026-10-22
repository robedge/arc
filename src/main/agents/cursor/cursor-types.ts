import { z } from 'zod'
import type { JsonObject, JsonRpcId } from '../rpc/json-rpc-peer'

/**
 * A hand-written subset of the Agent Client Protocol as `agent acp` speaks it (Cursor CLI
 * 2026.10.19). Only the fields Arc reads are listed, and every object is loose because the server
 * is hidden, only partly documented and changes between releases. `tests/fixtures/cursor/` pins
 * the shapes.
 */

export type { JsonObject, JsonRpcId }

export const ACP_PROTOCOL_VERSION = 1
export const CURSOR_AUTH_METHOD = 'cursor_login'

/** "Authentication required": `session/new` before `authenticate`, or a login that is gone. */
export const ACP_AUTH_REQUIRED = -32000
/** "Invalid params": an unknown model id, or a `session/load` of a session that is not there. */
export const ACP_INVALID_PARAMS = -32602
export const ACP_METHOD_NOT_FOUND = -32601

// ---- approvals ------------------------------------------------------------------------------

/** What a permission option does. Arc answers `allow_once` or `reject_once`, never `allow_always`. */
export type CursorOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'

export interface CursorPermissionOption {
  optionId: string
  name?: string
  kind: string
}

/** The tool call as the parser has seen it: the `tool_call` plus every `tool_call_update` so far. */
export interface CursorToolCall {
  toolCallId: string
  /** The latest title ("`git status`", "Edit `/x/notes.txt`", "arc: echo"). */
  title: string
  /** `read`, `edit`, `execute`, `other`, ... */
  kind: string
  /** `pending`, `in_progress` or `completed`. A blocked or failed call also ends `completed`. */
  status: string
  rawInput: JsonObject
  /** Absent until the call completes; a command that completed without one was refused. */
  rawOutput?: JsonObject
  locations: string[]
  /** `tool_call_update.content`, for example a diff. */
  content: unknown[]
  /** True once a `session/request_permission` named this call. */
  permissionAsked: boolean
  /** Epoch ms of the `tool_call`, of `in_progress`, and of `completed`. */
  startedAt: number
  inProgressAt?: number
  completedAt?: number
}

/**
 * One permission request, as the adapter hands it to the handler. Minimal on purpose: the
 * approvals task turns it into a `NormalizedAction`. The request itself carries no `rawInput`, so
 * `tool` (the preceding `tool_call`, which always arrives first) is where the command and paths are.
 */
export interface CursorApprovalRequest {
  agentId: string
  sessionId: string
  /** The JSON-RPC id of the request; it starts at 0, so never test it for truthiness. */
  requestId: JsonRpcId
  toolCallId: string
  title: string
  kind: string
  options: CursorPermissionOption[]
  /** The request's params, exactly as Cursor sent them. */
  raw: JsonObject
  tool?: CursorToolCall
}

/**
 * What the handler decides.
 * - `allow`: run this one action (the option of kind `allow_once`).
 * - `reject`: refuse it; the turn continues (the option of kind `reject_once`).
 * - `cancel`: refuse it and cancel the prompt turn (`outcome: cancelled`).
 *
 * The adapter picks the option by kind and never answers `allow_always`.
 */
export interface CursorApprovalDecision {
  decision: 'allow' | 'reject' | 'cancel'
  /** Why, when the decision is a `reject`. The adapter puts it in front of the next prompt (ACP's reject carries no text). */
  message?: string
}

/** The `signal.reason` when Arc withdrew the request (an interrupt). A stopped process aborts without it. */
export const CURSOR_APPROVAL_WITHDRAWN = 'withdrawn'

export interface CursorApprovalHandler {
  /** Decides one request. `signal` aborts when Arc cancels the turn or the process ends; the answer is then dropped. */
  handle(request: CursorApprovalRequest, signal: AbortSignal): Promise<CursorApprovalDecision>
}

// ---- responses ------------------------------------------------------------------------------

export const initializeResponseSchema = z.looseObject({
  protocolVersion: z.number().optional(),
  agentCapabilities: z
    .looseObject({
      loadSession: z.boolean().optional(),
      mcpCapabilities: z.looseObject({ http: z.boolean().optional() }).optional()
    })
    .optional()
})

export const cursorModelSchema = z.looseObject({ modelId: z.string(), name: z.string().optional() })

/** `session/new` and `session/load` (the load answer has no `sessionId`). */
export const sessionResponseSchema = z.looseObject({
  sessionId: z.string().optional(),
  modes: z
    .looseObject({
      currentModeId: z.string().optional(),
      availableModes: z.array(z.looseObject({ id: z.string() })).optional()
    })
    .nullish(),
  models: z
    .looseObject({
      currentModelId: z.string().optional(),
      availableModels: z.array(cursorModelSchema).optional()
    })
    .nullish()
})
export type CursorSessionResponse = z.infer<typeof sessionResponseSchema>

export const promptResponseSchema = z.looseObject({ stopReason: z.string() })

// ---- session/update -------------------------------------------------------------------------

export const sessionUpdateParamsSchema = z.looseObject({
  sessionId: z.string().optional(),
  update: z.looseObject({ sessionUpdate: z.string() })
})

export const textChunkSchema = z.looseObject({
  content: z.looseObject({ type: z.string().optional(), text: z.string().optional() })
})

const locationsSchema = z.array(z.looseObject({ path: z.string().optional() })).optional()

export const toolCallUpdateSchema = z.looseObject({
  toolCallId: z.string(),
  title: z.string().optional(),
  kind: z.string().optional(),
  status: z.string().optional(),
  rawInput: z.record(z.string(), z.unknown()).nullish(),
  rawOutput: z.record(z.string(), z.unknown()).nullish(),
  locations: locationsSchema,
  content: z.array(z.unknown()).optional()
})

export const availableCommandsSchema = z.looseObject({
  availableCommands: z.array(
    z.looseObject({ name: z.string(), description: z.string().optional() })
  )
})
export interface CursorCommand {
  name: string
  description: string
}

export const planUpdateSchema = z.looseObject({
  entries: z.array(z.looseObject({ content: z.string(), status: z.string().optional() }))
})

// ---- server requests ------------------------------------------------------------------------

export const permissionParamsSchema = z.looseObject({
  sessionId: z.string().optional(),
  toolCall: z.looseObject({
    toolCallId: z.string(),
    title: z.string().optional(),
    kind: z.string().optional(),
    status: z.string().optional()
  }),
  options: z.array(
    z.looseObject({ optionId: z.string(), name: z.string().optional(), kind: z.string() })
  )
})
