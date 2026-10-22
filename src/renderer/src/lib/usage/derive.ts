import type { SessionUsage } from '@shared/types/usage'

export type LimitSeverity = 'ok' | 'warn' | 'critical'

/** Amber from 80%, red from 95%. */
export function limitSeverity(percent: number): LimitSeverity {
  if (percent >= 95) return 'critical'
  if (percent >= 80) return 'warn'
  return 'ok'
}

const RANK: Record<LimitSeverity, number> = { ok: 0, warn: 1, critical: 2 }

/** The worst of several severities; 'ok' for none. */
export function worstSeverity(all: readonly LimitSeverity[]): LimitSeverity {
  return all.reduce<LimitSeverity>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok')
}

/** True when every agent of the session ran before Arc recorded usage, so its total is unknown, not 0. */
export function sessionNotRecorded(snapshot: SessionUsage | null): boolean {
  return (
    snapshot !== null &&
    snapshot.agents.length > 0 &&
    snapshot.agents.every((a) => a.recording === 'not-recorded')
  )
}

/**
 * What the session total reads when no agent has a number: "Not recorded" when any agent ran before
 * recording, "Not reported" when every agent is Cursor-like (no counts from the provider); null otherwise.
 */
export function sessionTotalGap(
  snapshot: SessionUsage | null
): 'not-recorded' | 'not-reported' | null {
  if (snapshot === null || snapshot.agents.length === 0) return null
  if (
    !snapshot.agents.every((a) => a.recording === 'not-recorded' || a.recording === 'not-reported')
  )
    return null
  return snapshot.agents.some((a) => a.recording === 'not-recorded')
    ? 'not-recorded'
    : 'not-reported'
}

/**
 * True for a Setup overhead suggestion whose setup is mostly the CLI's own (Arc's additions are under
 * 25% of it, the same integer rule the advice text uses), so switching off what agents load helps.
 */
export function cliHeavySetup(params: Record<string, unknown>): boolean {
  const setup = params['setupTokens']
  const arc = params['arcSetupTokens']
  return typeof setup === 'number' && typeof arc === 'number' && setup > 0 && arc * 100 < setup * 25
}
