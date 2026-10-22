import { PROVIDER_TRAITS } from './provider-traits'
import { PROVIDER_IDS, type ModelRef, type ProviderId, type RunningOn } from './types/provider'

/** The Claude model aliases the CLI accepts; shown capitalised. Everything else is shown as is. */
const CLAUDE_ALIASES: readonly string[] = ['opus', 'sonnet', 'haiku']

/** Between a provider and its model, in every label. */
const SEPARATOR = ' · '

/** Every provider id, in display order. */
export const providerIds: readonly ProviderId[] = PROVIDER_IDS

/** True when the value is one of the provider ids. */
export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** "Claude", "Codex" or "Cursor". */
export function providerName(provider: ProviderId): string {
  return PROVIDER_TRAITS[provider].name
}

/**
 * A Cursor model id as its label: "Auto" for `default[]`, otherwise the name followed by the effort
 * level and `fast` / `thinking` when switched on ("grok-4.7 · high · fast"). The context size is left out.
 */
export function cursorModelLabel(id: string): string {
  if (id === 'default[]') return 'Auto'
  const open = id.indexOf('[')
  if (open === -1) return id
  const params = id
    .slice(open + 1)
    .replace(/\]$/, '')
    .split(',')
    .map((part) => part.trim().split('='))
    .filter(([key]) => key !== undefined && key !== '')
  const parts: string[] = []
  for (const [key, value] of params) {
    if (
      (key === 'effort' || key === 'reasoning' || key?.endsWith('_effort')) &&
      value !== undefined
    ) {
      parts.push(value)
    }
  }
  for (const key of ['fast', 'thinking']) {
    if (params.some(([k, v]) => k === key && v === 'true')) parts.push(key)
  }
  return [id.slice(0, open), ...parts].join(SEPARATOR)
}

/** "Sonnet" for the Claude alias, "Auto" for Cursor's default; a Claude full id or a Codex id is shown as it is. */
export function shownModel(ref: ModelRef): string {
  if (ref.provider === 'cursor') return cursorModelLabel(ref.model)
  if (ref.provider === 'claude' && CLAUDE_ALIASES.includes(ref.model)) {
    return ref.model.charAt(0).toUpperCase() + ref.model.slice(1)
  }
  return ref.model
}

/** "Claude · Sonnet" or "Codex · gpt-5.5". */
export function modelLabel(ref: ModelRef): string {
  return `${providerName(ref.provider)}${SEPARATOR}${shownModel(ref)}`
}

/** The sentence for a model the provider's plan does not include: "Cursor refused Auto: it isn't on your Cursor plan. ..." */
export function planRefusedText(ref: ModelRef): string {
  const name = providerName(ref.provider)
  const shown = shownModel(ref)
  const advice =
    ref.provider === 'cursor' && shown !== 'Auto'
      ? 'Choose Auto or another model.'
      : 'Choose another model.'
  return `${name} refused ${shown}: it isn't on your ${name} plan. ${advice}`
}

/** True when the agent runs somewhere other than where it was asked to. */
export function hasFallback(runningOn: RunningOn): boolean {
  return (
    runningOn.requestedProvider !== undefined &&
    runningOn.requestedProvider !== runningOn.provider &&
    Boolean(runningOn.fallbackReason)
  )
}

/** `modelLabel`, or "Claude (Codex unavailable)" when the agent fell back to another provider. */
export function runningOnLabel(runningOn: RunningOn): string {
  if (hasFallback(runningOn) && runningOn.requestedProvider !== undefined) {
    return `${providerName(runningOn.provider)} (${providerName(runningOn.requestedProvider)} unavailable)`
  }
  return modelLabel(runningOn)
}
