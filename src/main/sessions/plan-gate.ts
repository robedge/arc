import type { PlanStatus, PlanWorkerView } from '@shared/types/session'
import { COMMAND_ID_PREFIX } from './command-routing'

export interface GatePlan {
  id: string
  status: PlanStatus
  workers: readonly PlanWorkerView[]
}

export interface GateMatch {
  plan: GatePlan
  entry: PlanWorkerView
  index: number
}

const norm = (value: string): string => value.trim().toLowerCase()

/** Two repo lists match when they name the same projects, in any order. */
export function sameRepos(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a.map(norm))
  const right = new Set(b.map(norm))
  if (left.size !== right.size) return false
  for (const item of left) if (!right.has(item)) return false
  return true
}

/** `codex:review x` and `claude:review x` are the same command as `/review x`. */
function commandText(value: string): string {
  const trimmed = value.trim()
  const id = new RegExp(`^(?:${COMMAND_ID_PREFIX}):(\\S[\\s\\S]*)$`).exec(trimmed)
  return id?.[1] !== undefined ? `/${id[1]}` : trimmed
}

/** Commands match on their full text; a missing command only matches a missing command. */
export function sameCommand(a: string | undefined, b: string | undefined): boolean {
  return norm(commandText(a ?? '')) === norm(commandText(b ?? ''))
}

/**
 * The plan-first gate (tech spec 2.5): `spawn_worker` passes only when an approved plan lists a worker
 * with this name, these repos and this command that has not been started yet. `isTaken` says whether an entry
 * already has a live worker. Returns null when nothing matches.
 */
export function matchApprovedEntry(
  plans: readonly GatePlan[],
  name: string,
  repos: readonly string[],
  isTaken: (planId: string, entry: PlanWorkerView) => boolean,
  command?: string
): GateMatch | null {
  for (const plan of plans) {
    if (plan.status !== 'approved') continue
    for (const [index, entry] of plan.workers.entries()) {
      if (norm(entry.name) !== norm(name)) continue
      if (!sameRepos(entry.repos, repos)) continue
      if (!sameCommand(entry.command, command)) continue
      if (isTaken(plan.id, entry)) continue
      return { plan, entry, index }
    }
  }
  return null
}
