import type { BrainState, SessionListStatus, SessionStatus } from '@shared/types/session'

export interface ListStatusInput {
  sessionStatus: SessionStatus
  brainState: BrainState
  /** Workers currently running (arrives with workers; 0 until then). */
  activeWorkers?: number
  /** Pending attention requests (arrives with the attention table; 0 until then). */
  pendingAttention?: number
}

/**
 * The single place the session list badge is derived. Precedence:
 * 1. session status 'stopped'              -> 'stopped'
 * 2. any pending attention request         -> 'needs-attention'
 * 3. brain thinking or an active worker    -> 'working'
 * 4. otherwise                             -> 'idle'
 */
export function deriveListStatus(input: ListStatusInput): SessionListStatus {
  if (input.sessionStatus === 'stopped') return 'stopped'
  if ((input.pendingAttention ?? 0) > 0) return 'needs-attention'
  if (input.brainState === 'thinking' || (input.activeWorkers ?? 0) > 0) return 'working'
  return 'idle'
}
