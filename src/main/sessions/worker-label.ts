import type { WorkerRow } from '../db/repositories/workers-repo'

/**
 * A merge resolver is a worker row like any other (it needs an id for its tokens and questions), marked
 * by this entry in `depends_on_json`. The brain can never produce it: it is not a worker id.
 */
export const RESOLVER_MARKER = 'arc:merge-resolver'

export function isResolverRow(row: Pick<WorkerRow, 'dependsOnJson'>): boolean {
  try {
    const parsed: unknown = JSON.parse(row.dependsOnJson)
    return Array.isArray(parsed) && parsed.includes(RESOLVER_MARKER)
  } catch {
    return false
  }
}

/** What a worker is called in the event log and in attention requests. */
export function workerLabel(
  row: Pick<WorkerRow, 'number' | 'slug' | 'dependsOnJson'> & { command?: string | null }
): string {
  if (isResolverRow(row)) return 'Conflict resolver'
  const name = commandName(row.command)
  return name === null ? `W${row.number} ${row.slug}` : `W${row.number} · /${name}`
}

/** The command's name without the slash and the arguments: "/awos:spec retry" gives "awos:spec". */
export function commandName(command: string | null | undefined): string | null {
  const match = /^\/(\S+)/.exec(command ?? '')
  return match?.[1] ?? null
}
