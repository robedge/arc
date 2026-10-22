import { workersPrefSchema } from '@shared/provider-schemas'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import { PROVIDER_IDS } from '@shared/types/provider'
import type {
  ModelRef,
  ProviderId,
  ProviderState,
  ProviderStatusMap,
  WorkersPref
} from '@shared/types/provider'
import { DEFAULT_WORKER_MODEL } from './worker-model'

/** The session columns that hold the provider choices. */
export interface SessionPrefColumns {
  workersPrefJson: string
  brainProvider: ProviderId
  brainModel: string
}

/** The session's Workers choice, read from `workers_pref_json`; unreadable JSON counts as Auto. */
export function workersPrefOf(row: Pick<SessionPrefColumns, 'workersPrefJson'>): WorkersPref {
  try {
    const parsed = workersPrefSchema.safeParse(JSON.parse(row.workersPrefJson))
    if (parsed.success) return parsed.data
  } catch {
    // Fall through to Auto.
  }
  return { mode: 'auto' }
}

/** What actually runs the brain right now. */
export interface EffectiveBrain {
  provider: ProviderId
  model: string
  /**
   * Set when the session asks for Codex or Cursor but it is not ready: another provider runs the
   * brain (`provider`) and the stored preference is unchanged (the per-reply fallback). `limit`: it
   * is `ok` but at its usage limit.
   */
  unavailable?: ProviderState | 'unknown' | 'limit'
  /** The provider the session asked for; set together with `unavailable`. */
  requested?: ProviderId
}

/** What the brain's fallback chain needs besides the statuses. */
export interface BrainChain {
  /** Providers at their usage limit. */
  limited?: ReadonlySet<ProviderId> | undefined
  /** A provider's default model, for a stand-in other than Claude; left out, only Claude stands in. */
  defaultFor?: ((provider: ProviderId) => ModelRef | undefined) | undefined
}

/**
 * The provider and model the brain process runs with. A Codex or Cursor brain needs that provider to
 * be `ok` and within its limit; otherwise the first ready provider of the chain (Claude, then Codex)
 * stands in: Claude · Sonnet, or the other provider's default. A status that no check has produced
 * yet counts as not ready, as it does for workers.
 */
export function effectiveBrain(
  row: Pick<SessionPrefColumns, 'brainProvider' | 'brainModel'>,
  status: ProviderStatusMap,
  forced?: ProviderState,
  chain: BrainChain = {}
): EffectiveBrain {
  const wanted = row.brainProvider
  if (wanted === 'claude') return { provider: 'claude', model: row.brainModel }
  const state = status[wanted]?.state
  // The provider refused the start at the handshake: the status has not caught up yet.
  const unavailable: ProviderState | 'unknown' | 'limit' | undefined =
    forced ??
    (state !== 'ok' ? (state ?? 'unknown') : chain.limited?.has(wanted) ? 'limit' : undefined)
  if (unavailable === undefined) return { provider: wanted, model: row.brainModel }
  const stand = brainStandIn(wanted, status, chain)
  return { ...stand, unavailable, requested: wanted }
}

/** The first ready provider in `fallbackOrder` other than `from`: Claude · Sonnet unless Claude is down. */
function brainStandIn(
  from: ProviderId,
  status: ProviderStatusMap,
  chain: BrainChain
): { provider: ProviderId; model: string } {
  const order = [...PROVIDER_IDS].sort(
    (a, b) => PROVIDER_TRAITS[a].fallbackOrder - PROVIDER_TRAITS[b].fallbackOrder
  )
  for (const provider of order) {
    if (provider === from) continue
    const state = status[provider]?.state
    if (provider === 'claude') {
      if (state === undefined || state === 'ok') break
      continue
    }
    if (state !== 'ok' || chain.limited?.has(provider) === true) continue
    const ref = chain.defaultFor?.(provider)
    if (ref !== undefined) return { provider, model: ref.model }
  }
  return { provider: 'claude', model: DEFAULT_WORKER_MODEL }
}
