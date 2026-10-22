import type { BridgeAgent } from '../bridge/types'
import { normalizeCodexApproval } from '../agents/codex/codex-normalize'
import {
  APPROVAL_WITHDRAWN,
  type ApprovalHandler,
  type CodexApprovalDecision,
  type CodexApprovalRequest
} from '../agents/codex/codex-types'
import { ACTION_WITHDRAWN, describeAction } from './attention-coordinator'
import type { McpToolCatalogue } from '../personal/mcp-tool-catalogue'
import { toStoredCall } from '../policy/normalized-action'
import type { ActionDecision, ActionMeta, NormalizedAction } from '../policy/normalized-action'

/** How the handler reaches the coordinator: the worker's `requestAction`, or the brain's. */
export type RequestAction = (
  agent: BridgeAgent,
  action: NormalizedAction,
  meta: ActionMeta,
  call: { signal: AbortSignal }
) => Promise<ActionDecision>

const DECLINE_ON_ERROR: CodexApprovalDecision = { decision: 'decline' }

/**
 * The user's Codex servers whose every tool call Arc put into `prompt` mode, filled in when the
 * agent starts. An empty set (the list could not be read) makes the handler ask about every personal
 * tool call that reaches it.
 */
export class McpCoverage {
  servers: ReadonlySet<string> = new Set()
}

/**
 * The Codex `ApprovalHandler` of one agent (tech spec 2.2). A request becomes a `NormalizedAction`,
 * which the coordinator classifies and, where it must, puts in front of the brain and the user.
 *
 * - allow -> `accept` (this one action only; the handler never returns a session-wide grant);
 * - refused -> `decline`, with the reason as `message`, which the adapter steers into the turn
 *   before it answers;
 * - refused with `cancelTurn` -> `cancel`, which ends the turn;
 * - a coordinator that fails -> `decline`.
 *
 * Codex withdrawing a request (the turn was interrupted) cancels the stored request; the process
 * ending only abandons the wait and leaves the request pending for the resume.
 */
export function createCodexApprovalHandler(deps: {
  agent: BridgeAgent
  requestAction: RequestAction
  /** Settles whether a personal MCP tool only reads; without it the item's own hint stands. */
  mcp?: McpToolCatalogue | undefined
  covered?: McpCoverage | undefined
}): ApprovalHandler {
  return {
    async handle(
      request: CodexApprovalRequest,
      signal: AbortSignal
    ): Promise<CodexApprovalDecision> {
      const normalized = normalizeCodexApproval(request)
      let action: NormalizedAction = normalized
      if (normalized.kind === 'mcp' && deps.mcp) {
        // A lookup that fails asks: nothing then says the tool only reads.
        action = await deps.mcp
          .codexAction(deps.agent.agentId, normalized, deps.covered?.servers ?? new Set())
          .catch(() => ({ ...normalized, readOnly: 'unknown' as const }))
      }
      const call = new AbortController()
      const forward = (): void =>
        call.abort(signal.reason === APPROVAL_WITHDRAWN ? ACTION_WITHDRAWN : undefined)
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
      try {
        const decision = await deps.requestAction(deps.agent, action, {}, { signal: call.signal })
        if (decision.allow) return { decision: 'accept' }
        if (decision.cancelTurn === true) return { decision: 'cancel' }
        const stored = toStoredCall(action)
        const what = describeAction(stored.toolName, stored.input)
        return {
          decision: 'decline',
          message: `Arc declined \`${what}\`. ${decision.message ?? ''}`.trim()
        }
      } catch {
        return DECLINE_ON_ERROR
      } finally {
        signal.removeEventListener('abort', forward)
      }
    }
  }
}
