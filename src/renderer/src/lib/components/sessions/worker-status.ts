import type { WorkerStatus, WorkerView } from '@shared/types/session'

export type WorkerTone = 'faint' | 'accent' | 'attention' | 'success' | 'danger'

export const WORKER_STATUS = {
  queued: { label: 'Queued', tone: 'faint' },
  starting: { label: 'Starting', tone: 'accent' },
  working: { label: 'Working', tone: 'accent' },
  needs_approval: { label: 'Needs approval', tone: 'attention' },
  has_question: { label: 'Has a question', tone: 'attention' },
  done: { label: 'Done', tone: 'success' },
  merged: { label: 'Merged', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  stopped: { label: 'Stopped', tone: 'faint' }
} as const satisfies Record<WorkerStatus, { label: string; tone: WorkerTone }>

export const WORKER_TONE_CLASS: Record<WorkerTone, string> = {
  faint: 'text-text-faint',
  accent: 'text-accent',
  attention: 'text-attention',
  success: 'text-success',
  danger: 'text-danger'
}

/** Statuses in which a worker can still be stopped. */
export const STOPPABLE: readonly WorkerStatus[] = [
  'queued',
  'starting',
  'working',
  'needs_approval',
  'has_question'
]

/** The command's name with its slash, without arguments: "/awos:spec retry" gives "/awos:spec". */
export function commandLabel(command: string | null | undefined): string | null {
  const match = /^\/\S+/.exec(command ?? '')
  return match?.[0] ?? null
}

/** What a worker card or dialog is called: `W2 · api-retry`, `W2 · /awos:spec`, or `Conflict resolver · <repo>`. */
export function workerTitle(
  worker: Pick<WorkerView, 'role' | 'number' | 'slug' | 'worktrees'> & { command?: string }
): string {
  if (worker.role !== 'resolver') {
    return `W${worker.number} · ${commandLabel(worker.command) ?? worker.slug}`
  }
  const repo = worker.worktrees[0]?.projectName
  return repo ? `Conflict resolver · ${repo}` : 'Conflict resolver'
}

/** Statuses in which a worker has finished and can be removed from the session. */
export const REMOVABLE: readonly WorkerStatus[] = ['done', 'merged', 'failed', 'stopped']

export function unmergedWarning(count: number): string {
  return `Its ${count} unmerged ${count === 1 ? 'commit' : 'commits'} will be discarded.`
}

/** "2 helpers" / "1 helper"; null when none run (absent counts as 0). */
export function helpersLabel(count: number | undefined): string | null {
  if (!count || count < 1) return null
  return `${count} ${count === 1 ? 'helper' : 'helpers'}`
}

/** Helper activity lines the worker manager writes into the terminal log. */
export function isHelperLine(line: string): boolean {
  return line.startsWith('  ↳ helper')
}

/** Statuses in which the user can step in on a worker (spec 006): it is in progress and has something to interrupt. */
export const STEPPABLE: readonly WorkerStatus[] = [
  'starting',
  'working',
  'needs_approval',
  'has_question'
]

/** Whether the tab offers Step in: an in-progress, non-resolver worker the user is not already controlling. */
export function canStepIn(worker: Pick<WorkerView, 'status' | 'role' | 'userControl'>): boolean {
  return worker.role !== 'resolver' && !worker.userControl && STEPPABLE.includes(worker.status)
}

/** Shown beside (or instead of) the status while the user is in control; the real status still applies underneath. */
export function controlLabel(worker: Pick<WorkerView, 'userControl'>): string | null {
  if (worker.userControl === 'active') return "You're in control"
  if (worker.userControl === 'paused') return "You're in control (paused)"
  return null
}
