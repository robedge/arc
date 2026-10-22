import type { AgentLoadOff, LoadRole } from '../../shared/types/agent-load'

/**
 * What the user switched off for a role (spec 009 tech spec 2.1). It reads the stored setting on every
 * call and keeps nothing, so a change applies to the next agent that starts.
 */
export type OffFor = (role: LoadRole) => ReadonlySet<string>

export function createLoadSelection(read: () => AgentLoadOff): OffFor {
  return (role) => new Set(read()[role])
}

/** An empty selection: everything on (used when no setting is wired, as in tests). */
export const NOTHING_OFF: OffFor = () => new Set<string>()
