import { and, asc, eq, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { sessionProjects } from '../schema'
import type {
  DirtyHandling,
  NewSessionProjectRow,
  SessionProjectMembership,
  SessionProjectRow
} from '../schema'

export type { DirtyHandling, NewSessionProjectRow, SessionProjectMembership, SessionProjectRow }

export class SessionProjectsRepo {
  constructor(private readonly db: DbHandle) {}

  /** One transaction; returns the inserted rows in order. */
  insertMany(rows: readonly Omit<NewSessionProjectRow, 'id'>[]): SessionProjectRow[] {
    if (rows.length === 0) return []
    return this.db.transaction((tx) =>
      rows.map((r) => tx.insert(sessionProjects).values(r).returning().get())
    )
  }

  listBySession(sessionId: string): SessionProjectRow[] {
    return this.db
      .select()
      .from(sessionProjects)
      .where(eq(sessionProjects.sessionId, sessionId))
      .orderBy(asc(sessionProjects.id))
      .all()
  }

  /** Every git repository any session uses, once each. */
  listGitPaths(): string[] {
    return this.db
      .selectDistinct({ path: sessionProjects.projectPath })
      .from(sessionProjects)
      .where(eq(sessionProjects.readOnly, false))
      .all()
      .map((r) => r.path)
  }

  setBranch(
    sessionId: string,
    projectId: string,
    branchName: string,
    baseBranch: string | null,
    previousBranch: string | null
  ): void {
    this.db
      .update(sessionProjects)
      .set({ branchName, baseBranch, previousBranch })
      .where(this.match(sessionId, projectId))
      .run()
  }

  setDirtyHandling(
    sessionId: string,
    projectId: string,
    handling: DirtyHandling,
    stashRef: string | null = null
  ): void {
    this.db
      .update(sessionProjects)
      .set({ dirtyHandling: handling, stashRef })
      .where(this.match(sessionId, projectId))
      .run()
  }

  setMembership(id: number, membership: SessionProjectMembership): void {
    this.db.update(sessionProjects).set({ membership }).where(eq(sessionProjects.id, id)).run()
  }

  /** The project moved to another folder: later workers, merges and reviews use the new path. */
  setLocation(id: number, projectPath: string, projectName: string): void {
    this.db
      .update(sessionProjects)
      .set({ projectPath, projectName })
      .where(eq(sessionProjects.id, id))
      .run()
  }

  delete(id: number): void {
    this.db.delete(sessionProjects).where(eq(sessionProjects.id, id)).run()
  }

  /** Writes the branch-point sha only while it is null; returns whether it wrote. */
  setBaseSha(id: number, sha: string): boolean {
    const res = this.db
      .update(sessionProjects)
      .set({ baseSha: sha })
      .where(and(eq(sessionProjects.id, id), isNull(sessionProjects.baseSha)))
      .run()
    return res.changes > 0
  }

  /** Records the latest push, overwriting any earlier one; returns whether the row exists. */
  recordPush(
    id: number,
    push: { remote: string; branch: string; sha: string; at: number }
  ): boolean {
    const res = this.db
      .update(sessionProjects)
      .set({
        pushedRemote: push.remote,
        pushedBranch: push.branch,
        pushedSha: push.sha,
        pushedAt: push.at
      })
      .where(eq(sessionProjects.id, id))
      .run()
    return res.changes > 0
  }

  private match(sessionId: string, projectId: string) {
    return and(eq(sessionProjects.sessionId, sessionId), eq(sessionProjects.projectId, projectId))
  }
}
