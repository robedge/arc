import type { z } from 'zod'
import type { ProviderId } from '../../shared/types/provider'
import type { ActionDecision, ActionMeta, NormalizedAction } from '../policy/normalized-action'

/** Which tool set an agent gets. Tokens map to one role. */
export type BridgeRole = 'brain' | 'worker'

/** Who is calling: resolved from the bearer token, never from the request body. */
export interface BridgeAgent {
  sessionId: string
  agentId: string
  role: BridgeRole
  /**
   * The provider that runs the agent, when the bridge needs to know it. A Cursor agent gets the
   * polling shape for long calls (`polling.ts`); left out, the agent is treated like Claude's.
   */
  provider?: ProviderId
}

/** A tool failure the model should see. Becomes an `isError` result with `{error, message}` JSON. */
export class BridgeToolError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeToolError'
    this.code = code
  }
}

export interface ProposedWorker {
  name: string
  task: string
  /** Project names of the session. */
  repos: string[]
  /** The brain's advisory provider; the user's Workers choice can override it. */
  provider?: ProviderId | undefined
  model?: string | undefined
  rationale: string
  /** The slash command the worker runs (`/awos:spec retry settings`); absent for an ordinary task. */
  command?: string | undefined
}

export interface ProposePlanInput {
  workers: ProposedWorker[]
}

export type PlanDecisionResult =
  | {
      planId: string
      decision: 'approved'
      /** Each worker's approved model. */
      models: Record<string, string>
      /** The provider of each worker's approved model. */
      providers: Record<string, ProviderId>
    }
  | { planId: string; decision: 'changes_requested'; comment: string }
  | { planId: string; decision: 'rejected' }

export interface SpawnWorkerInput {
  name: string
  task: string
  repos: string[]
  /** The brain's advisory provider; the user's Workers choice can override it. */
  provider?: ProviderId | undefined
  model?: string | undefined
  dependsOn?: string[] | undefined
  /** The slash command the worker runs as its first message; `task` stays a short description. */
  command?: string | undefined
}

export interface SpawnWorkerResult {
  workerId: string
  status: 'started' | 'queued'
  /** What the worker really runs on, so the brain sees overrides and fallbacks. */
  provider: ProviderId
  model: string
  /** Why the choice differs from what the brain asked for; null when it does not. */
  note: string | null
}

export interface WorkerStatusEntry {
  id: string
  number: number
  name: string
  status: string
  note: string | null
  files: string[]
  lastReport: string | null
}

export interface MergeWorkerInput {
  workerId: string
}

export type MergeResultKind = 'clean' | 'resolved' | 'needs_user'

export interface MergeWorkerResult {
  /** The worker's work is in the session branch and its card is Merged. */
  merged: boolean
  result: MergeResultKind
  /** Files the merge changed, as `<project>/<path>`. */
  files: string[]
  /** Projects whose checkout could not be fast-forwarded yet (unsaved changes there). */
  pendingFastForward?: string[] | undefined
  /** Set when `merged` is false: what is still outstanding. */
  note?: string | undefined
}

export interface SyncWorkerInput {
  workerId: string
  fromWorkerId: string
  /** What changed, in the brain's words; it goes to the receiving worker as a message. */
  note?: string | undefined
}

export interface SyncWorkerResult {
  synced: boolean
  /** Files the receiving worker must resolve itself (`<project>/<path>`). */
  conflicts?: string[] | undefined
  files: string[]
  /** The receiving worker was running and got the message. */
  notified: boolean
  /** The user is in control of the receiving worker: the message is held until they hand it back. */
  queued?: boolean | undefined
}

export interface ReportProgressInput {
  note: string
  filesChanged?: string[] | undefined
}

export interface ReportDoneInput {
  summary: string
  commits?: string[] | undefined
}

/** What the CLI sends to the permission-prompt tool (S0 item 1). */
export interface RequestPermissionInput {
  tool_name: string
  input: Record<string, unknown>
  tool_use_id?: string | undefined
}

/** The permission tool's answer, as JSON text: `allow` runs the tool, `deny` refuses it (S0 item 1). */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface ResolveRequestInput {
  requestId: string
  decision: 'approve' | 'deny' | 'answer'
  answer?: string | undefined
  note?: string | undefined
}

/** What the tools need from the engine. The orchestrator of a session implements it. */
export interface BridgeServices {
  /** Blocks until the user decides. The bridge keeps the MCP call alive with progress notifications. */
  proposePlan(
    agent: BridgeAgent,
    input: ProposePlanInput,
    call: { signal: AbortSignal }
  ): Promise<PlanDecisionResult>
  spawnWorker(agent: BridgeAgent, input: SpawnWorkerInput): Promise<SpawnWorkerResult>
  messageWorker(
    agent: BridgeAgent,
    input: { workerId: string; text: string }
  ): Promise<{ delivered: boolean; queued?: boolean | undefined }>
  getWorkerStatus(agent: BridgeAgent, input: { workerId?: string | undefined }): WorkerStatusEntry[]
  /** Brain. Merges a Done worker into the session branch; waits for the repository's merge queue. */
  mergeWorker(agent: BridgeAgent, input: MergeWorkerInput): Promise<MergeWorkerResult>
  /** Brain. Brings another worker's merged (or finished) changes into this worker's working copy. */
  syncWorker(agent: BridgeAgent, input: SyncWorkerInput): Promise<SyncWorkerResult>
  reportProgress(agent: BridgeAgent, input: ReportProgressInput): { ok: true }
  reportDone(agent: BridgeAgent, input: ReportDoneInput): Promise<{ ok: true }>
  /**
   * Worker or brain. Blocks until the brain or the user decides (the user, for the brain's own
   * shell commands); the answer is the CLI's permission decision.
   */
  requestPermission(
    agent: BridgeAgent,
    input: RequestPermissionInput,
    call: { signal: AbortSignal }
  ): Promise<PermissionDecision>
  /**
   * Worker or brain, any provider: the same decision as `requestPermission` on a provider-neutral
   * action. Codex's approval requests arrive here (through the adapter's `ApprovalHandler`), not
   * through the bridge. Aborting `call.signal` with `ACTION_WITHDRAWN` cancels the stored request.
   */
  requestAction(
    agent: BridgeAgent,
    action: NormalizedAction,
    meta: ActionMeta,
    call: { signal: AbortSignal }
  ): Promise<ActionDecision>
  /** Worker. Blocks until the brain or the user answers. */
  askBrain(
    agent: BridgeAgent,
    input: { question: string },
    call: { signal: AbortSignal }
  ): Promise<{ answer: string }>
  /** Brain. Fails with `policy_requires_user` for a request that must go to the user. */
  resolveRequest(agent: BridgeAgent, input: ResolveRequestInput): { ok: true }
  /** Brain. Passes a request on to the user. */
  escalateToUser(agent: BridgeAgent, input: { requestId: string; reason: string }): { ok: true }
  /** Brain. Blocks until the user answers. */
  askUser(
    agent: BridgeAgent,
    input: { question: string; choices?: string[] },
    call: { signal: AbortSignal }
  ): Promise<{ answer: string }>
}

export interface BridgeCallContext {
  agent: BridgeAgent
  services: BridgeServices
  /** Aborts when the call dies (client gone, timeout) or the agent's token is revoked. */
  signal: AbortSignal
}

export interface BridgeTool<TShape extends z.ZodRawShape = z.ZodRawShape> {
  /** Without the `mcp__arc__` prefix. */
  name: string
  /** `any`: both the brain and workers are shown the tool. */
  role: BridgeRole | 'any'
  description: string
  inputShape: TShape
  /** Declares `readOnlyHint` (only matters for plan mode, which the brain does not use). */
  readOnly?: boolean
  /**
   * The call can wait on a person or a queue for a long time. While the client supplied a
   * `progressToken`, the bridge sends `notifications/progress` every 15 s so the call is never idle.
   */
  longRunning?: boolean
  /** Who a Cursor agent is told it is still waiting for after 50 s ("the user"). Defaults to "the result". */
  waitingFor?: string
  /** The arguments are validated against `inputShape` before this runs. */
  run(args: z.infer<z.ZodObject<TShape>>, ctx: BridgeCallContext): unknown
}

/** A tool as the registry holds it: arguments typed loosely, already validated by the server. */
export interface AnyBridgeTool extends Omit<BridgeTool, 'run'> {
  run(args: Record<string, unknown>, ctx: BridgeCallContext): unknown
}

/** Keeps each tool file's argument types precise while the registry holds them as one type. */
export function defineTool<TShape extends z.ZodRawShape>(tool: BridgeTool<TShape>): AnyBridgeTool {
  return {
    ...tool,
    run: (args, ctx) => tool.run(args as z.infer<z.ZodObject<TShape>>, ctx)
  }
}

/** MCP tool names as the CLI sees them (`mcp__arc__<name>`). */
export const MCP_SERVER_NAME = 'arc'
export const mcpToolName = (name: string): string => `mcp__${MCP_SERVER_NAME}__${name}`
