import { sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { sessionFileReads } from '../schema'

export interface RepeatedRead {
  path: string
  /** Reads summed across agents. */
  count: number
  agentKeys: string[]
}

/** How often each agent read each file in a session. */
export class FileReadsRepo {
  constructor(private readonly db: DbHandle) {}

  bump(sessionId: string, agentKey: string, path: string, now: number): void {
    this.db
      .insert(sessionFileReads)
      .values({ sessionId, agentKey, path, readCount: 1, lastReadAt: now })
      .onConflictDoUpdate({
        target: [sessionFileReads.sessionId, sessionFileReads.agentKey, sessionFileReads.path],
        set: { readCount: sql`${sessionFileReads.readCount} + 1`, lastReadAt: now }
      })
      .run()
  }

  /** How many different files the agent read in the session. */
  distinctFiles(sessionId: string, agentKey: string): number {
    const row = this.db.get<{ n: number }>(sql`
      SELECT COUNT(*) AS n FROM session_file_reads
      WHERE session_id = ${sessionId} AND agent_key = ${agentKey}`)
    return row?.n ?? 0
  }

  /** Files read at least `min` times in total across the session's agents, most read first. */
  repeated(sessionId: string, min: number): RepeatedRead[] {
    const rows = this.db.all<{ path: string; count: number; agent_keys: string }>(sql`
      SELECT path, SUM(read_count) AS count, group_concat(agent_key) AS agent_keys
      FROM session_file_reads
      WHERE session_id = ${sessionId}
      GROUP BY path
      HAVING SUM(read_count) >= ${min}
      ORDER BY count DESC, path ASC`)
    return rows.map((r) => ({
      path: r.path,
      count: r.count,
      agentKeys: r.agent_keys.split(',').sort()
    }))
  }
}
