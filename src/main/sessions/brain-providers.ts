import { modelLabel, providerName } from '@shared/provider-label'
import type {
  ModelInfo,
  ModelRef,
  ProviderId,
  ProviderModels,
  ProviderStatusMap,
  WorkersPref
} from '@shared/types/provider'
import type { ProviderPlan } from '@shared/types/usage'
import { MIN_CODEX_VERSION, MIN_CURSOR_VERSION } from '@shared/types/provider'

/** What the "Providers and models" block is built from, read each time the brain starts. */
export interface ProvidersPromptInput {
  /** What runs the brain (after any fallback). */
  brain: ModelRef
  /** The session's Workers choice. */
  workers: WorkersPref
  /** The models each provider offers. Codex is empty unless it is `ok`. */
  models: ProviderModels
  status: ProviderStatusMap
  /**
   * How full Claude's fullest current plan limit is (0-100), read when the prompt is built. Left
   * out when Claude's plan is not known; the prompt then says nothing about it.
   */
  claudePlanPercent?: number | undefined
}

/** Claude's plan meter at or above this many percent makes the brain prefer Codex or Cursor. */
export const PLAN_PREFER_OTHER_PERCENT = 80

/** The most Cursor models the brain prompt lists. */
export const MAX_CURSOR_PROMPT_MODELS = 15

/** The fullest current (not yet reset) limit of one provider's meter, or undefined when it has none. */
export function fullestPlanPercent(
  plans: readonly ProviderPlan[],
  provider: ProviderId
): number | undefined {
  const limits = plans.find((p) => p.provider === provider)?.limits ?? []
  const current = limits.filter((l) => l.stale !== true).map((l) => l.usedPercent)
  return current.length === 0 ? undefined : Math.max(...current)
}

function modelList(models: readonly ModelInfo[]): string {
  return models.map((m) => `${m.ref.model} (${m.tier}${m.isDefault ? ', default' : ''})`).join(', ')
}

/** Why a provider cannot run workers, or undefined when it can. */
export function unavailableReason(
  provider: ProviderId,
  status: ProviderStatusMap
): string | undefined {
  if (provider === 'claude') return undefined
  const name = providerName(provider)
  switch (status[provider]?.state) {
    case 'ok':
      return undefined
    case 'missing':
      return `${name} isn't installed`
    case 'signed_out':
      return `${name} isn't signed in`
    case 'unsupported':
      return `${name} is older than ${provider === 'codex' ? MIN_CODEX_VERSION : MIN_CURSOR_VERSION}, which Arc needs`
    case 'error':
      return `${name} couldn't be checked`
    default:
      return `${name} hasn't been checked yet`
  }
}

/**
 * At most `MAX_CURSOR_PROMPT_MODELS` Cursor models, in list order (Auto first): one per base model
 * first (its first variant), then more variants while there is room.
 */
export function cursorPromptModels(models: readonly ModelInfo[]): ModelInfo[] {
  const chosen = new Set<ModelInfo>()
  const bases = new Set<string>()
  for (const m of models) {
    const key = m.base ?? m.ref.model
    if (chosen.size >= MAX_CURSOR_PROMPT_MODELS) break
    if (bases.has(key)) continue
    bases.add(key)
    chosen.add(m)
  }
  for (const m of models) {
    if (chosen.size >= MAX_CURSOR_PROMPT_MODELS) break
    chosen.add(m)
  }
  return models.filter((m) => chosen.has(m))
}

function cursorModelLine(models: readonly ModelInfo[]): string {
  const shown = cursorPromptModels(models)
  const list = shown.map((m) => `${m.label} (${m.ref.model})`).join(', ')
  const more = models.length - shown.length
  return `- Cursor models: ${list}${more > 0 ? `, and ${more} more variants that Arc also accepts by id` : ''}. Use the id in \`model\`; Arc also accepts the label.`
}

function providerLine(provider: ProviderId, input: ProvidersPromptInput): string {
  const name = providerName(provider)
  const reason = unavailableReason(provider, input.status)
  if (reason !== undefined) return `- ${name}: unavailable (${reason}). Do not choose it.`
  const models = input.models[provider]
  if (models.length === 0) {
    return `- ${name}: available, but it lists no models. Leave \`model\` unset to use its default.`
  }
  if (provider === 'cursor') return cursorModelLine(models)
  return `- ${name} models: ${modelList(models)}.`
}

function workersGuidance(input: ProvidersPromptInput): string[] {
  const { workers } = input
  const codexUp = unavailableReason('codex', input.status) === undefined
  const cursorUp = unavailableReason('cursor', input.status) === undefined
  if (workers.mode === 'model') {
    return [
      `The user pinned Workers to ${modelLabel(workers.model)}: every worker runs on it. Do not set provider or model on spawn_worker or propose_plan.`
    ]
  }
  if (workers.mode === 'provider') {
    return [
      `The user set Workers to ${providerName(workers.provider)}: every worker runs on a ${providerName(workers.provider)} model. Do not set provider. You may set model to one of the ${providerName(workers.provider)} models above.`
    ]
  }
  const lines = [
    'Workers is on Auto, so you choose the provider and model of each worker:',
    '- Default to Claude.'
  ]
  if (codexUp) {
    lines.push(
      "- Choose Codex for a review, for a second opinion on another worker's change (a different model family sees different things), or when the user asks for Codex."
    )
  }
  if (cursorUp) {
    lines.push(
      '- Choose Cursor when the user asks for it, when the work needs a model only Cursor offers, or when you want a third opinion next to Claude and Codex.'
    )
  }
  const down = [codexUp ? undefined : 'Codex', cursorUp ? undefined : 'Cursor'].filter(
    (n): n is string => n !== undefined
  )
  if (down.length === 2) {
    lines.push(
      '- Codex and Cursor are unavailable now, so choose Claude for every worker, even if the user asks for Codex or Cursor; tell the user why.'
    )
  } else if (down.length === 1) {
    lines.push(
      `- ${down[0]} is unavailable now, so do not choose it, even if the user asks; tell the user why.`
    )
  }
  const percent = input.claudePlanPercent
  if (percent !== undefined && percent >= PLAN_PREFER_OTHER_PERCENT && (codexUp || cursorUp)) {
    const others = [codexUp ? 'Codex' : undefined, cursorUp ? 'Cursor' : undefined]
      .filter((n): n is string => n !== undefined)
      .join(' or ')
    lines.push(
      `- Claude's plan meter is at ${Math.round(percent)}%, so prefer ${others} for new workers unless the user asks for Claude or the work needs a Claude model.`
    )
  }
  lines.push(
    '- Say which provider you chose and why, in your reply or on the plan. The user can change either on the plan card.',
    '- The result of spawn_worker says what the worker really runs on.'
  )
  return lines
}

/**
 * The "Providers and models" block of the brain prompt (version 6): the models each provider
 * offers, what is unavailable and why, and how the session's Workers choice limits the brain.
 */
export function providersSection(input: ProvidersPromptInput): string {
  return [
    'Providers and models:',
    `You run on ${modelLabel(input.brain)}. Workers run on Claude, on Codex (OpenAI) or on Cursor. spawn_worker and propose_plan take an optional \`provider\` ("claude", "codex" or "cursor") and \`model\`.`,
    providerLine('claude', input),
    providerLine('codex', input),
    providerLine('cursor', input),
    ...workersGuidance(input)
  ].join('\n')
}
