import type { ProviderId, ProviderStatusMap, RunningOn } from '@shared/types/provider'
import { reasonOf } from '../models/provider-resolution'
import { fallbackReasonText } from '../providers/fallback-text'
import { effectiveBrain } from './session-prefs'
import type { BrainChain, SessionPrefColumns } from './session-prefs'

/** The stored columns that say what runs a worker. */
export interface WorkerProviderColumns {
  provider: ProviderId
  model: string
  requestedProvider: ProviderId | null
  fallbackReason: string | null
}

/** A worker's `runningOn`, filled from its columns. The fallback fields appear only when it fell back. */
export function workerRunningOn(row: WorkerProviderColumns): RunningOn {
  return {
    provider: row.provider,
    model: row.model,
    ...(row.requestedProvider !== null && row.fallbackReason !== null
      ? { requestedProvider: row.requestedProvider, fallbackReason: row.fallbackReason }
      : {})
  }
}

/**
 * The brain's `runningOn`: `sessions.brain_provider` with `brain_model`. While the session asks for
 * Codex or Cursor and it is not ready, another provider replies (Claude · Sonnet first): it carries the fallback
 * (`requestedProvider` and the reason sentence) and follows the status, the stored choice stays.
 */
export function brainRunningOn(
  row: Pick<SessionPrefColumns, 'brainProvider' | 'brainModel'>,
  status: ProviderStatusMap,
  chain?: BrainChain
): RunningOn {
  const brain = effectiveBrain(row, status, undefined, chain)
  if (brain.unavailable === undefined || brain.requested === undefined) {
    return { provider: brain.provider, model: brain.model }
  }
  return {
    provider: brain.provider,
    model: brain.model,
    requestedProvider: brain.requested,
    fallbackReason: fallbackReasonText(reasonOf(brain.unavailable), brain.requested)
  }
}
