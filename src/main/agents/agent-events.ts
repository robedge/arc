import type { ProviderId } from '../../shared/types/provider'

/** Provider-neutral events the agent layer emits. Each one carries the agent it came from and a timestamp. */

export interface AgentEventBase {
  agentId: string
  /** Milliseconds since the epoch, taken when the line was parsed. */
  ts: number
}

/** One plan limit window as an agent reports it. `resetsAt` is epoch seconds. */
export interface RateLimitWindow {
  /** Stable per provider: `five_hour`, `seven_day`, `codex:300`. */
  windowId: string
  /** "5h", "Weekly". */
  label: string
  /** 0 to 100. */
  usedPercent: number
  resetsAt: number | null
}

export type AgentErrorKind = 'auth' | 'not-installed' | 'rate-limit' | 'api' | 'parse' | 'unknown'

/** How a turn ended. `ok` and `interrupted` on the event stay for the consumers that predate it. */
export type TurnStatus = 'completed' | 'interrupted' | 'failed'

export interface McpServerStatus {
  name: string
  status: string
}

/** A background helper (subagent) the CLI runs inside the worker's process. */
export interface HelperTask {
  taskId: string
  description: string
}

export type UsageScope = 'turn' | 'helper'

/** Token buckets that do not overlap (see the `usage` event). */
export interface UsageBuckets {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/** One request's input, split the same way. */
export type UsageCall = Pick<UsageBuckets, 'input' | 'cacheWrite' | 'cacheRead'>

/** The longest `readPath` a tool-use event carries. */
export const READ_PATH_MAX = 500

export type AgentEvent =
  | (AgentEventBase & {
      type: 'session'
      provider: ProviderId
      providerSessionId: string
      model: string
      permissionMode?: string
      mcpServers: McpServerStatus[]
    })
  | (AgentEventBase & {
      type: 'text-delta'
      messageId: string
      text: string
      parentToolUseId?: string
    })
  | (AgentEventBase & {
      type: 'thinking-delta'
      messageId: string
      text: string
      parentToolUseId?: string
    })
  | (AgentEventBase & {
      type: 'assistant-message'
      messageId: string
      text: string
      /** Set when a helper wrote it: the id of the `Agent` tool call that started the helper. */
      parentToolUseId?: string
    })
  | (AgentEventBase & {
      type: 'tool-use'
      toolUseId: string
      name: string
      summary: string
      /** The file a read tool targets (at most 500 characters); absent for other tools. */
      readPath?: string
      parentToolUseId?: string
    })
  | (AgentEventBase & {
      type: 'tool-result'
      toolUseId: string
      parentToolUseId?: string
      isError: boolean
      /** The result's text (capped); absent when the result carried no text. */
      content?: string
    })
  | (AgentEventBase & {
      type: 'turn-result'
      ok: boolean
      interrupted: boolean
      durationMs: number
      /** The provider's id for the turn, when it has one. */
      turnId?: string
      status: TurnStatus
    })
  /**
   * Token spend of one agent turn (`scope: 'turn'`) or of one Claude helper message (`'helper'`).
   * The four buckets do not overlap: `input` is fresh input only, never cache reads or writes.
   * Absent figures are unknown, not zero.
   */
  | (AgentEventBase & {
      type: 'usage'
      scope: UsageScope
      /** Codex: the provider's turn id. Claude: a per-process sequence number ("1", "2", ...). */
      turnId?: string
      /** The full model id as the provider reports it; absent when the parser does not know it. */
      model?: string
      input: number
      cacheWrite: number
      cacheRead: number
      output: number
      /** The largest single request of the turn: its input + cacheWrite + cacheRead. */
      maxCallInput: number
      /** Requests behind this event. Codex sends one event per request (1 each); the recorder sums. */
      callCount: number
      /** The agent's first request of a new thread. Sent once, on the first turn event. */
      firstCall?: UsageCall
      contextWindow?: number
      /** Per-model split of the turn (Claude `modelUsage`); informational, `input`... are authoritative. */
      perModel?: Record<string, UsageBuckets>
      /** True when built from assistant messages because the `result` reported nothing (interrupt). */
      partial: boolean
    })
  /**
   * Claude only: the running total of the top-level requests of the turn in progress, sent whenever an
   * assistant message adds or changes one. It replaces the previous progress event and is not spend by
   * itself: the turn's `usage` event (at its `result`) is. `turnId` is the id that event will carry.
   */
  | (AgentEventBase & {
      type: 'usage-progress'
      turnId: string
      input: number
      cacheWrite: number
      cacheRead: number
      output: number
      callCount: number
    })
  | (AgentEventBase & {
      type: 'rate-limit'
      provider: ProviderId
      /** Epoch seconds, as the CLI reports it. */
      resetsAt?: number
      /** The CLI's status word (`allowed`, `rejected`, ...). The event is also sent for `allowed`. */
      status?: string
      /** Every plan window the provider reported with this event, for the plan meters. */
      windows?: RateLimitWindow[]
      /** The account's plan (Codex), when reported. */
      planType?: string
    })
  /** A helper started (system/task_started). `toolUseId` is the `Agent` call that started it. */
  | (AgentEventBase & {
      type: 'task-started'
      taskId: string
      toolUseId: string
      description: string
      backgrounded: boolean
    })
  /** A helper reached a terminal status (system/task_notification or task_updated). */
  | (AgentEventBase & {
      type: 'task-ended'
      taskId: string
      status: string
      summary?: string
    })
  /** The authoritative list of running helpers (system/background_tasks_changed). */
  | (AgentEventBase & { type: 'tasks-changed'; running: number; tasks: HelperTask[] })
  /** Answer to a control_request (for example the interrupt). */
  | (AgentEventBase & { type: 'control-ack'; requestId: string; ok: boolean })
  /** A turn began (the provider's own signal; Claude does not emit it). */
  | (AgentEventBase & { type: 'turn-started'; turnId: string })
  /** Informational: an approval was asked or answered. The decision itself goes through the approval handler. */
  | (AgentEventBase & {
      type: 'approval'
      approvalId: string
      state: 'requested' | 'resolved'
      summary: string
      decision?: 'allow' | 'deny' | 'cancelled'
    })
  | (AgentEventBase & { type: 'plan-updated'; items: { text: string; status: string }[] })
  /** The provider served the turn with another model than the one asked for. */
  | (AgentEventBase & { type: 'model-rerouted'; from: string; to: string })
  | (AgentEventBase & { type: 'mcp-status'; name: string; status: string })
  | (AgentEventBase & {
      type: 'user-input-request'
      requestId: string
      questions: { question: string; header?: string }[]
    })
  | (AgentEventBase & { type: 'error'; kind: AgentErrorKind; message: string })
  | (AgentEventBase & {
      type: 'exit'
      code: number | null
      signal: string | null
      /** False only for a crash: a non-zero exit, or a signal, that we did not cause. */
      expected: boolean
      stderrTail: string
    })
  /** Raw text the process wrote to stderr, as it arrives (chunks may split lines). */
  | (AgentEventBase & { type: 'stderr'; text: string })
  | (AgentEventBase & { type: 'unknown'; raw: unknown })

export type AgentEventType = AgentEvent['type']
