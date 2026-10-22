import { modelLabel, providerName } from '@shared/provider-label'
import { PROVIDER_TRAITS } from '@shared/provider-traits'
import type { ModelRef, ProviderId } from '@shared/types/provider'
import type { FallbackReason } from '../models/provider-resolution'

/**
 * Every line the user reads when Codex or Cursor cannot be used and another provider stands in
 * (functional spec 2.6 and 2.7). One module, so the worker, brain and command variants cannot drift
 * apart. The provider's name and login command come from `PROVIDER_TRAITS`; `provider` defaults to
 * Codex, the first provider that needed these lines.
 */

interface ReasonText {
  cause: string
  action?: string
  resume?: string
}

/** Why `provider` cannot run, and what to do about it. `action` is absent when there is nothing to do. */
function reasonText(provider: ProviderId, reason: FallbackReason): ReasonText {
  const { loginCommand } = PROVIDER_TRAITS[provider]
  const name = providerName(provider)
  switch (reason) {
    case 'signed_out':
      return {
        cause: `${name} isn't signed in`,
        action: `Run ${loginCommand} in Terminal to use ${name}.`,
        resume: `Run ${loginCommand} in Terminal, then continue`
      }
    case 'missing':
      return {
        cause: `${name} isn't installed`,
        action: `Install ${name} to use it.`,
        resume: `Install ${name}, then continue`
      }
    case 'unsupported':
      return {
        cause: `This ${name} is too old for Arc`,
        action: `Update ${name} to use it.`,
        resume: `Update ${name}, then continue`
      }
    case 'error':
      return {
        cause: `Arc couldn't check ${name}`,
        resume: `Check ${name} again in Settings, then continue`
      }
    case 'limit':
      return {
        cause: `${name} has reached its usage limit`,
        resume: `Wait for the ${name} limit to lift, then continue`
      }
  }
}

function join(...parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p !== '').join(' ')
}

/**
 * The reason as a sentence for the card: "Codex isn't signed in. Run codex login in Terminal to use
 * Codex." Stored in `workers.fallback_reason` and shown as `runningOn.fallbackReason`.
 */
export function fallbackReasonText(reason: FallbackReason, provider: ProviderId = 'codex'): string {
  const { cause, action } = reasonText(provider, reason)
  return join(`${cause}.`, action)
}

/**
 * A worker that was meant for `provider` runs on `standIn` (default Claude): "Cursor isn't signed in,
 * so W2 runs on Claude. Run agent login in Terminal to use Cursor."
 */
export function workerFallbackText(
  workerLabel: string,
  reason: FallbackReason,
  provider: ProviderId = 'codex',
  standIn: ProviderId = 'claude'
): string {
  const { cause, action } = reasonText(provider, reason)
  return join(`${cause}, so ${workerLabel} runs on ${providerName(standIn)}.`, action)
}

const CLAUDE_SONNET: ModelRef = { provider: 'claude', model: 'sonnet' }

/** The brain was meant for `provider` and replies from `standIn` (default Claude · Sonnet). */
export function brainFallbackText(
  reason: FallbackReason,
  provider: ProviderId = 'codex',
  standIn: ModelRef = CLAUDE_SONNET
): string {
  const { cause, action } = reasonText(provider, reason)
  return join(`${cause}, so the brain replies from ${modelLabel(standIn)}.`, action)
}

/** A worker that stopped cannot be moved to another provider; it waits for its own instead. */
export function workerCannotContinueText(
  workerLabel: string,
  reason: FallbackReason,
  provider: ProviderId = 'codex'
): string {
  const { cause, resume } = reasonText(provider, reason)
  return join(`${cause}, so ${workerLabel} can't continue.`, `${resume} ${workerLabel}.`)
}

/** A command that exists only on one provider cannot run elsewhere: the worker fails, without a process. */
export function commandNeedsProviderText(
  workerLabel: string,
  command: string,
  reason: FallbackReason,
  provider: ProviderId = 'codex'
): string {
  return join(
    `${workerLabel} needs ${providerName(provider)} for ${command}.`,
    fallbackReasonText(reason, provider)
  )
}
