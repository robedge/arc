import { isResolverRow, type WorkerRow } from '../db/repositories/workers-repo'

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
