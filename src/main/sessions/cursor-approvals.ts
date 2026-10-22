import type { BridgeAgent } from '../bridge/types'
import { MCP_SERVER_NAME } from '../bridge/types'
import { normalizeCursorApproval } from '../agents/cursor/cursor-normalize'
import {
  CURSOR_APPROVAL_WITHDRAWN,
  type CursorApprovalDecision,
  type CursorApprovalHandler,
  type CursorApprovalRequest
} from '../agents/cursor/cursor-types'
import { ACTION_WITHDRAWN, describeAction } from './attention-coordinator'
import type { RequestAction } from './codex-approvals'
import { toStoredCall, type NormalizedAction } from '../policy/normalized-action'

type McpAction = Extract<NormalizedAction, { kind: 'mcp' }>

const REJECT_ON_ERROR: CursorApprovalDecision = { decision: 'reject' }

/**
 * The Cursor `CursorApprovalHandler` of one agent (tech spec 2.4), next to `createCodexApprovalHandler`.
 *
 * - calls to Arc's own `arc` server are answered at once, with no attention item;
 * - every other request goes to `requestAction`, so the coordinator, the allow rules and Auto-approve
 *   apply as for the other providers (an ordinary command inside the working copy is allowed there
 *   without an item);
 * - allow -> `allow` (the adapter answers the option of kind `allow_once`, never `allow_always`);
 * - refused -> `reject` with the reason as `message`, which the adapter puts in front of the next prompt;
 * - refused with `cancelTurn`, or a request withdrawn by an interrupt -> `cancel`;
 * - a coordinator that fails -> `reject`.
 */
export function createCursorApprovalHandler(deps: {
  agent: BridgeAgent
  requestAction: RequestAction
  /** User MCP servers switched off for this agent: a request for one is rejected (tech spec 2.5, defence in depth). */
  offServers?: () => ReadonlySet<string>
  /** Settles whether a user MCP tool only reads (`McpToolCatalogue.cursorAction`); left out, it asks. */
  resolveMcp?: (action: McpAction) => Promise<McpAction>
}): CursorApprovalHandler {
  return {
    async handle(
      request: CursorApprovalRequest,
      signal: AbortSignal
    ): Promise<CursorApprovalDecision> {
      let action = normalizeCursorApproval(request)
      if (action.kind === 'mcp' && action.server === MCP_SERVER_NAME) return { decision: 'allow' }
      if (action.kind === 'mcp' && deps.offServers?.().has(action.server)) {
        return {
          decision: 'reject',
          message: `The ${action.server} server is switched off for this agent in Settings, so \`${action.tool}\` was declined.`
        }
      }
      if (action.kind === 'mcp' && deps.resolveMcp) {
        action = await deps.resolveMcp(action).catch(() => action as McpAction)
      }
      const call = new AbortController()
      const forward = (): void =>
        call.abort(signal.reason === CURSOR_APPROVAL_WITHDRAWN ? ACTION_WITHDRAWN : undefined)
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
      try {
        const decision = await deps.requestAction(deps.agent, action, {}, { signal: call.signal })
        if (decision.allow) return { decision: 'allow' }
        if (decision.cancelTurn === true) return { decision: 'cancel' }
        const stored = toStoredCall(action)
        const what = describeAction(stored.toolName, stored.input)
        return {
          decision: 'reject',
          message: `Your request to run \`${what}\` was declined${decision.message ? `: ${decision.message}` : '.'}`
        }
      } catch {
        return REJECT_ON_ERROR
      } finally {
        signal.removeEventListener('abort', forward)
      }
    }
  }
}
