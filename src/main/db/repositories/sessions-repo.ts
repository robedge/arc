import { desc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { sessions } from '../schema'
import type { ModelRef, WorkersPref } from '../../../shared/types/provider'
import type { NewSessionRow, SessionMode, SessionRow, SessionStatus } from '../schema'

export type { NewSessionRow, SessionRow }

export class SessionsRepo {
  constructor(private readonly db: DbHandle) {}

  create(row: NewSessionRow): void {
    this.db.insert(sessions).values(row).run()
  }

  getById(id: string): SessionRow | undefined {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get()
  }

  listByGroup(groupId: string): SessionRow[] {
    return this.db
      .select()
      .from(sessions)
      .where(eq(sessions.groupId, groupId))
      .orderBy(desc(sessions.lastActiveAt), desc(sessions.id))
      .all()
  }

  rename(id: string, name: string): void {
    this.db.update(sessions).set({ name }).where(eq(sessions.id, id)).run()
  }

  setMode(id: string, mode: SessionMode): void {
    this.db.update(sessions).set({ mode }).where(eq(sessions.id, id)).run()
  }

  /** Throws the raw SQLite CHECK error when outside 1..6. */
  setWorkerLimit(id: string, workerLimit: number): void {
    this.db.update(sessions).set({ workerLimit }).where(eq(sessions.id, id)).run()
  }

  /** The session's Workers choice (`workers_pref_json`); the legacy `model` column is left alone. */
  setWorkersPref(id: string, pref: WorkersPref): void {
    this.db
      .update(sessions)
      .set({ workersPrefJson: JSON.stringify(pref) })
      .where(eq(sessions.id, id))
      .run()
  }

  /** The brain's provider and model, together. */
  setBrain(id: string, brain: ModelRef): void {
    this.db
      .update(sessions)
      .set({ brainProvider: brain.provider, brainModel: brain.model })
      .where(eq(sessions.id, id))
      .run()
  }

  setAutoApprove(id: string, autoApprove: boolean): void {
    this.db.update(sessions).set({ autoApprove }).where(eq(sessions.id, id)).run()
  }

  setBrainCwd(id: string, brainCwd: string): void {
    this.db.update(sessions).set({ brainCwd }).where(eq(sessions.id, id)).run()
  }

  setBrainPromptVersion(id: string, brainPromptVersion: number): void {
    this.db.update(sessions).set({ brainPromptVersion }).where(eq(sessions.id, id)).run()
  }

  setSlug(id: string, slug: string | null): void {
    this.db.update(sessions).set({ slug }).where(eq(sessions.id, id)).run()
  }

  touch(id: string, lastActiveAt: number): void {
    this.db.update(sessions).set({ lastActiveAt }).where(eq(sessions.id, id)).run()
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.update(sessions).set({ status }).where(eq(sessions.id, id)).run()
  }

  delete(id: string): void {
    this.db.delete(sessions).where(eq(sessions.id, id)).run()
  }
}
