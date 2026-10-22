import { and, asc, eq } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { sessionAllowRules } from '../schema'
import type { NewSessionAllowRuleRow, SessionAllowRuleRow } from '../schema'

export type { NewSessionAllowRuleRow, SessionAllowRuleRow }

export class AllowRulesRepo {
  constructor(private readonly db: DbHandle) {}

  create(row: NewSessionAllowRuleRow): void {
    this.db.insert(sessionAllowRules).values(row).run()
  }

  listBySession(sessionId: string): SessionAllowRuleRow[] {
    return this.db
      .select()
      .from(sessionAllowRules)
      .where(eq(sessionAllowRules.sessionId, sessionId))
      .orderBy(asc(sessionAllowRules.createdAt), asc(sessionAllowRules.id))
      .all()
  }

  /** True when a rule of that session was removed. */
  remove(sessionId: string, ruleId: string): boolean {
    return (
      this.db
        .delete(sessionAllowRules)
        .where(and(eq(sessionAllowRules.sessionId, sessionId), eq(sessionAllowRules.id, ruleId)))
        .run().changes > 0
    )
  }
}
