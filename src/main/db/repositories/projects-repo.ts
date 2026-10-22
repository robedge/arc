import { and, asc, eq, max, notExists, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { groupProjects, projects } from '../schema'
import type { ProjectRow, NewProjectRow } from '../schema'

export type { ProjectRow, NewProjectRow }

export interface ProjectMemberRow extends ProjectRow {
  sortOrder: number
  addedAt: number
}

export interface ProjectUpdate {
  path?: string
  displayName?: string
  isGit?: boolean
  lastSeenAt?: number | null
}

export class ProjectsRepo {
  constructor(private readonly db: DbHandle) {}

  getById(id: string): ProjectRow | undefined {
    return this.db.select().from(projects).where(eq(projects.id, id)).get()
  }

  /** Every project folder Arc knows, in any group. */
  allPaths(): string[] {
    return this.db
      .select({ path: projects.path })
      .from(projects)
      .all()
      .map((r) => r.path)
  }

  getByPath(path: string): ProjectRow | undefined {
    return this.db.select().from(projects).where(eq(projects.path, path)).get()
  }

  /** Throws the raw SQLite error on a duplicate path; use `isUniqueViolation` to detect it. */
  insert(row: NewProjectRow): void {
    this.db.insert(projects).values(row).run()
  }

  /** Throws the raw SQLite error on a duplicate path; use `isUniqueViolation` to detect it. */
  update(id: string, fields: ProjectUpdate): void {
    if (Object.keys(fields).length === 0) return
    this.db.update(projects).set(fields).where(eq(projects.id, id)).run()
  }

  /** Deletes the project only when no group references it. Returns whether it was deleted. */
  deleteIfOrphan(projectId: string): boolean {
    const res = this.db
      .delete(projects)
      .where(
        and(
          eq(projects.id, projectId),
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(groupProjects)
              .where(eq(groupProjects.projectId, projects.id))
          )
        )
      )
      .run()
    return res.changes > 0
  }

  /** Deletes every project with no memberships; returns the number removed. */
  deleteOrphans(): number {
    const res = this.db
      .delete(projects)
      .where(
        notExists(
          this.db
            .select({ one: sql`1` })
            .from(groupProjects)
            .where(eq(groupProjects.projectId, projects.id))
        )
      )
      .run()
    return res.changes
  }

  listByGroup(groupId: string): ProjectMemberRow[] {
    return this.db
      .select({
        id: projects.id,
        path: projects.path,
        displayName: projects.displayName,
        isGit: projects.isGit,
        lastSeenAt: projects.lastSeenAt,
        createdAt: projects.createdAt,
        sortOrder: groupProjects.sortOrder,
        addedAt: groupProjects.addedAt
      })
      .from(groupProjects)
      .innerJoin(projects, eq(projects.id, groupProjects.projectId))
      .where(eq(groupProjects.groupId, groupId))
      .orderBy(asc(groupProjects.sortOrder), asc(groupProjects.addedAt))
      .all()
  }

  /** Throws the raw SQLite error when already a member; use `isUniqueViolation` to detect it. */
  addMembership(groupId: string, projectId: string, sortOrder: number, addedAt: number): void {
    this.db.insert(groupProjects).values({ groupId, projectId, sortOrder, addedAt }).run()
  }

  removeMembership(groupId: string, projectId: string): void {
    this.db
      .delete(groupProjects)
      .where(and(eq(groupProjects.groupId, groupId), eq(groupProjects.projectId, projectId)))
      .run()
  }

  hasMembership(groupId: string, projectId: string): boolean {
    return (
      this.db
        .select({ one: sql`1` })
        .from(groupProjects)
        .where(and(eq(groupProjects.groupId, groupId), eq(groupProjects.projectId, projectId)))
        .get() !== undefined
    )
  }

  /** Highest sort_order in the group, or -1 when it has no projects. */
  maxSortOrder(groupId: string): number {
    const row = this.db
      .select({ m: max(groupProjects.sortOrder) })
      .from(groupProjects)
      .where(eq(groupProjects.groupId, groupId))
      .get()
    return row?.m ?? -1
  }

  /**
   * Moves `fromProjectId`'s memberships to `intoProjectId` (skipping groups that already contain
   * `into`), then deletes `from`. Atomic.
   */
  mergeMemberships(fromProjectId: string, intoProjectId: string): void {
    this.db.transaction((tx) => {
      const moving = tx
        .select()
        .from(groupProjects)
        .where(eq(groupProjects.projectId, fromProjectId))
        .all()
      for (const m of moving) {
        const exists = tx
          .select({ one: sql`1` })
          .from(groupProjects)
          .where(
            and(eq(groupProjects.groupId, m.groupId), eq(groupProjects.projectId, intoProjectId))
          )
          .get()
        if (!exists) {
          tx.insert(groupProjects)
            .values({ ...m, projectId: intoProjectId })
            .run()
        }
      }
      tx.delete(groupProjects).where(eq(groupProjects.projectId, fromProjectId)).run()
      tx.delete(projects).where(eq(projects.id, fromProjectId)).run()
    })
  }
}
