import { and, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { brainThreads } from '../schema'
import type { ProviderId } from '../../../shared/types/provider'

/** The brain's thread id (Claude session id or Codex thread id) per session and provider. */
export class BrainThreadsRepo {
  constructor(private readonly db: DbHandle) {}

  get(sessionId: string, provider: ProviderId): string | undefined {
    return this.db
      .select({ threadId: brainThreads.threadId })
      .from(brainThreads)
      .where(and(eq(brainThreads.sessionId, sessionId), eq(brainThreads.provider, provider)))
      .get()?.threadId
  }

  set(sessionId: string, provider: ProviderId, threadId: string, now: number): void {
    this.db
      .insert(brainThreads)
      .values({ sessionId, provider, threadId, updatedAt: now })
      .onConflictDoUpdate({
        target: [brainThreads.sessionId, brainThreads.provider],
        set: { threadId, updatedAt: now }
      })
      .run()
  }
}
