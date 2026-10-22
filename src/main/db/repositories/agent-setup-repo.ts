import { and, eq, isNull } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { agentSetup } from '../schema'

export type AgentSetupRow = typeof agentSetup.$inferSelect

export interface UpsertAdditionsInput {
  sessionId: string
  agentKey: string
  provider: string
  model: string | null
  arcAdditionsTokens: number
  at: number
}

export interface SetFixedSetupInput {
  sessionId: string
  agentKey: string
  provider: string
  fixedSetupTokens: number
}

/** Setup size per (session, agent, provider); see `agentSetup`. */
export class AgentSetupRepo {
  constructor(private readonly db: DbHandle) {}

  /** Inserts or refreshes Arc's additions, model and estimate time; never touches the fixed setup. */
  upsertAdditions(input: UpsertAdditionsInput): void {
    this.db
      .insert(agentSetup)
      .values({
        sessionId: input.sessionId,
        agentKey: input.agentKey,
        provider: input.provider,
        model: input.model,
        arcAdditionsTokens: input.arcAdditionsTokens,
        estimatedAt: input.at
      })
      .onConflictDoUpdate({
        target: [agentSetup.sessionId, agentSetup.agentKey, agentSetup.provider],
        set: {
          model: input.model,
          arcAdditionsTokens: input.arcAdditionsTokens,
          estimatedAt: input.at
        }
      })
      .run()
  }

  /**
   * Sets the fixed setup only while it is still null, so a resume (whose first request also carries
   * the old conversation) never overwrites it. Returns whether it was set; false when no row exists.
   */
  setFixedSetupIfMissing(input: SetFixedSetupInput): boolean {
    const result = this.db
      .update(agentSetup)
      .set({ fixedSetupTokens: input.fixedSetupTokens })
      .where(
        and(
          eq(agentSetup.sessionId, input.sessionId),
          eq(agentSetup.agentKey, input.agentKey),
          eq(agentSetup.provider, input.provider),
          isNull(agentSetup.fixedSetupTokens)
        )
      )
      .run()
    return result.changes > 0
  }

  get(sessionId: string, agentKey: string, provider: string): AgentSetupRow | undefined {
    return this.db
      .select()
      .from(agentSetup)
      .where(
        and(
          eq(agentSetup.sessionId, sessionId),
          eq(agentSetup.agentKey, agentKey),
          eq(agentSetup.provider, provider)
        )
      )
      .get()
  }

  forSession(sessionId: string): AgentSetupRow[] {
    return this.db
      .select()
      .from(agentSetup)
      .where(eq(agentSetup.sessionId, sessionId))
      .orderBy(agentSetup.agentKey, agentSetup.provider)
      .all()
  }
}
