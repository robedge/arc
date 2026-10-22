import { modelLabel, providerName } from '@shared/provider-label'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import { PROVIDER_IDS } from '@shared/types/provider'
import type {
  ModelRef,
  ModelTier,
  ProviderId,
  ProviderState,
  ProviderStatusMap,
  WorkersPref
} from '@shared/types/provider'
import { DEFAULT_WORKER_MODEL, normalizeModel } from '../sessions/worker-model'

/** Which rule decided the worker's target. */
export type TargetSource = 'command' | 'session' | 'plan' | 'brain' | 'default'

/** Why a provider could not be used. */
export type FallbackReason = 'missing' | 'signed_out' | 'error' | 'unsupported' | 'limit'

/** What the resolver needs to know about models; `ModelRegistry` implements it. */
export interface ModelCatalog {
  /** True for a model the provider offers or an agent reported. */
  has(ref: ModelRef): boolean
  /**
   * The listed model a ref names, by id or (for Cursor) by label in any case; undefined when it names
   * none. Left out, `has` alone decides and the ref is used as given.
   */
  resolve?(ref: ModelRef): ModelRef | undefined
  /** The provider's default; undefined when it offers no model right now (Codex is down). */
  defaultFor(provider: ProviderId): ModelRef | undefined
  /** The provider's fast-tier model, for a fast worker that another provider has to stand in for. */
  fastFor?(provider: ProviderId): ModelRef | undefined
  tierOf(ref: ModelRef): ModelTier
}

export interface WorkerTargetInput {
  /** A slash command forces its provider (Slice 7 passes it; nothing does yet). `name` is for the note. */
  command?: { provider: ProviderId; name?: string } | undefined
  /** The session's Workers choice. */
  sessionPref: WorkersPref
  /** What the user picked on the plan card. */
  planChoice?: Partial<ModelRef> | null | undefined
  /** What the brain proposed (`spawn_worker` or the plan entry). */
  proposal?: Partial<ModelRef> | null | undefined
  registry: ModelCatalog
  status: ProviderStatusMap
  /** Providers that are `ok` but at their usage limit (the retry failed too): new work goes elsewhere. */
  limited?: ReadonlySet<ProviderId> | undefined
}

export interface WorkerTarget {
  ref: ModelRef
  /** The rule that supplied the model, or the provider when only the provider was decided. */
  source: TargetSource
  /** Explanations for the brain: dropped picks, unknown models, a fallback. */
  notes: string[]
  /** Set when the chosen provider could not be used and another one runs instead (`ref`). */
  fallback?: { from: ModelRef; reason: FallbackReason }
  /**
   * Set instead of `fallback` when a Codex or Cursor command is forced and that provider is not
   * ready: the command exists only there, so no stand-in runs it and `ref` stays the target. The
   * worker fails without a process.
   */
  blocked?: { from: ModelRef; reason: FallbackReason; command: string }
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** The fallback reason for a status that is not `ok`; no status yet counts as `error`. */
export function reasonOf(state: ProviderState | 'unknown' | 'limit' | undefined): FallbackReason {
  return state === undefined || state === 'ok' || state === 'unknown' ? 'error' : state
}

const REASON_TEXT: Record<FallbackReason, string> = {
  missing: "isn't installed",
  signed_out: "isn't signed in",
  unsupported: 'is too old',
  error: "isn't available right now",
  limit: 'has reached its usage limit'
}

/** The Claude model that stands in for a Codex one: fast becomes haiku, anything else sonnet. */
export function claudeStandIn(tier: ModelTier): ModelRef {
  return { provider: 'claude', model: tier === 'fast' ? 'haiku' : DEFAULT_WORKER_MODEL }
}

/**
 * Who runs in place of `from` (tech spec 2.8): the first provider in `fallbackOrder` other than
 * `from` that is ready, Claude before Codex before Cursor. Claude counts as ready until a check says
 * otherwise. The model is the provider's default, or its fast model for a fast tier; Claude's comes
 * from `claudeStandIn`. When nobody is ready Claude stands in anyway: it is the last resort.
 */
export function standInFor(
  from: ProviderId,
  tier: ModelTier,
  registry: ModelCatalog,
  status: ProviderStatusMap,
  limited?: ReadonlySet<ProviderId>
): ModelRef {
  const order = [...PROVIDER_IDS].sort(
    (a, b) => PROVIDER_TRAITS[a].fallbackOrder - PROVIDER_TRAITS[b].fallbackOrder
  )
  for (const provider of order) {
    if (provider === from) continue
    const state = status[provider]?.state
    if (provider === 'claude') {
      if (state === undefined || state === 'ok') return claudeStandIn(tier)
      continue
    }
    if (state !== 'ok' || limited?.has(provider) === true) continue
    const ref =
      (tier === 'fast' ? registry.fastFor?.(provider) : undefined) ?? registry.defaultFor(provider)
    if (ref !== undefined) return ref
  }
  return claudeStandIn(tier)
}

/**
 * The provider and model a new worker runs on (tech spec 2.5). Pure: no I/O, no clock.
 *
 * Provider, first match wins: the command's provider; the session's pinned model or provider; the
 * plan card's provider; the brain's provider; Claude. A pick that loses on provider is dropped and
 * explained in `notes`.
 *
 * Model within that provider, first match wins: the session's pinned model; the plan card's model;
 * the brain's model; the provider's default. A model that does not belong to the provider is
 * skipped; one that does but is unknown gives the default plus a note (the next candidate is not
 * tried). Blank values count as unset.
 *
 * Availability: Codex or Cursor that is not `ok`, lists no model or is at its limit gives a stand-in
 * (`standInFor`) and `fallback`.
 */
export function resolveWorkerTarget(input: WorkerTargetInput): WorkerTarget {
  const { command, sessionPref, registry, status, limited } = input
  const notes: string[] = []
  const pins = sessionPref.mode === 'auto' ? undefined : sessionPref
  const pickedProvider = input.planChoice?.provider ?? input.proposal?.provider

  // ---- provider ----
  let provider: ProviderId
  let providerSource: TargetSource
  if (command) {
    provider = command.provider
    providerSource = 'command'
  } else if (sessionPref.mode === 'model') {
    provider = sessionPref.model.provider
    providerSource = 'session'
  } else if (sessionPref.mode === 'provider') {
    provider = sessionPref.provider
    providerSource = 'session'
  } else if (input.planChoice?.provider !== undefined) {
    provider = input.planChoice.provider
    providerSource = 'plan'
  } else if (input.proposal?.provider !== undefined) {
    provider = input.proposal.provider
    providerSource = 'brain'
  } else {
    provider = 'claude'
    providerSource = 'default'
  }

  if (pickedProvider !== undefined && pickedProvider !== provider) {
    if (command) {
      notes.push(
        `${command.name ?? 'The command'} is a ${PROVIDER_TRAITS[command.provider].cliName} command, so this worker runs on ${providerName(provider)}.`
      )
    } else if (sessionPref.mode === 'model') {
      notes.push(
        `Workers is set to ${modelLabel(sessionPref.model)}, so this worker uses it instead of ${providerName(pickedProvider)}.`
      )
    } else if (sessionPref.mode === 'provider') {
      notes.push(
        `Workers is set to ${providerName(provider)}, so this worker uses a ${providerName(provider)} model.`
      )
    }
  }

  // ---- model ----
  const candidates: [TargetSource, string | undefined][] = [
    [
      'session',
      pins?.mode === 'model' && pins.model.provider === provider ? pins.model.model : undefined
    ],
    ['plan', belongs(input.planChoice, provider)],
    ['brain', belongs(input.proposal, provider)]
  ]
  const fallbackDefault = registry.defaultFor(provider)
  // A model of another provider cannot be checked while it is down; the availability step below replaces it.
  const unchecked = provider !== 'claude' && status[provider]?.state !== 'ok'
  let model: string | undefined
  let modelSource: TargetSource | undefined
  for (const [source, value] of candidates) {
    if (value === undefined) continue
    const ref: ModelRef = { provider, model: provider === 'claude' ? normalizeModel(value) : value }
    const matched = unchecked || registry.has(ref) ? ref : registry.resolve?.(ref)
    if (matched !== undefined) {
      model = matched.model
      modelSource = source
    } else {
      notes.push(
        `Unknown model "${value}" (${source}); used ${fallbackDefault?.model ?? 'the default'} instead.`
      )
      model = fallbackDefault?.model
      modelSource = 'default'
    }
    break
  }
  if (model === undefined) {
    model = fallbackDefault?.model
    modelSource = undefined
  }

  // ---- availability ----
  if (provider !== 'claude') {
    const state = status[provider]?.state
    const atLimit = limited?.has(provider) === true
    if (state !== 'ok' || model === undefined || atLimit) {
      const from: ModelRef = { provider, model: model ?? 'default' }
      const reason = state === 'ok' && model !== undefined ? 'limit' : reasonOf(state)
      if (command) {
        const name = command.name ?? 'The command'
        notes.push(
          `${name} needs ${providerName(provider)}, and ${providerName(provider)} ${REASON_TEXT[reason]}.`
        )
        return {
          ref: from,
          source: 'command',
          notes,
          blocked: { from, reason, command: command.name ?? '' }
        }
      }
      const to = standInFor(
        provider,
        model === undefined ? 'balanced' : registry.tierOf(from),
        registry,
        status,
        limited
      )
      notes.push(
        `${providerName(provider)} ${REASON_TEXT[reason]}, so this worker runs on ${modelLabel(to)}.`
      )
      return {
        ref: to,
        source: modelSource ?? providerSource,
        notes,
        fallback: { from, reason }
      }
    }
  }

  return {
    ref: { provider, model: model ?? DEFAULT_WORKER_MODEL },
    source: modelSource ?? providerSource,
    notes
  }
}

/** A pick's model when it can run on `provider`: no provider named, or the same one. */
function belongs(
  pick: Partial<ModelRef> | null | undefined,
  provider: ProviderId
): string | undefined {
  if (!pick || (pick.provider !== undefined && pick.provider !== provider)) return undefined
  return clean(pick.model)
}
