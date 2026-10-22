import { and, eq, notInArray, sql } from 'drizzle-orm'
import type { DbHandle } from '../client'
import { ulid } from '../ids'
import { knowledgeItems } from '../schema'
import type { KnowledgeItemRow, NewKnowledgeItemRow } from '../schema'

export type { KnowledgeItemRow, NewKnowledgeItemRow }

export type KnowledgeItemInput = Omit<NewKnowledgeItemRow, 'id'> & { id?: string }

export class KnowledgeItemsRepo {
  constructor(private readonly db: DbHandle) {}

  listBySection(sectionId: string): KnowledgeItemRow[] {
    return this.db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.sectionId, sectionId))
      .orderBy(sql`${knowledgeItems.title} COLLATE NOCASE`, knowledgeItems.relPath)
      .all()
  }

  getById(id: string): KnowledgeItemRow | undefined {
    return this.db.select().from(knowledgeItems).where(eq(knowledgeItems.id, id)).get()
  }

  getByRelPath(groupId: string, relPath: string): KnowledgeItemRow | undefined {
    return this.db
      .select()
      .from(knowledgeItems)
      .where(and(eq(knowledgeItems.groupId, groupId), eq(knowledgeItems.relPath, relPath)))
      .get()
  }

  /** Inserts, or on a (group_id, rel_path) conflict updates every column except id. */
  upsertByRelPath(input: KnowledgeItemInput): KnowledgeItemRow {
    const { id, ...fields } = input
    this.db
      .insert(knowledgeItems)
      .values({ ...fields, id: id ?? ulid() })
      .onConflictDoUpdate({
        target: [knowledgeItems.groupId, knowledgeItems.relPath],
        set: fields
      })
      .run()
    const row = this.getByRelPath(input.groupId, input.relPath)
    if (!row) throw new Error('knowledge item missing after upsert')
    return row
  }

  deleteByRelPath(groupId: string, relPath: string): void {
    this.db
      .delete(knowledgeItems)
      .where(and(eq(knowledgeItems.groupId, groupId), eq(knowledgeItems.relPath, relPath)))
      .run()
  }

  /** Removes the section's cached rows whose rel_path is not in `keepRelPaths`. */
  deleteMissing(groupId: string, sectionId: string, keepRelPaths: string[]): void {
    const scope = and(eq(knowledgeItems.groupId, groupId), eq(knowledgeItems.sectionId, sectionId))
    this.db
      .delete(knowledgeItems)
      .where(
        keepRelPaths.length > 0
          ? and(scope, notInArray(knowledgeItems.relPath, keepRelPaths))
          : scope
      )
      .run()
  }

  /** Keeps the id. Throws the raw SQLite error when toRelPath already exists. */
  renameRelPath(groupId: string, fromRelPath: string, toRelPath: string): void {
    this.db
      .update(knowledgeItems)
      .set({ relPath: toRelPath })
      .where(and(eq(knowledgeItems.groupId, groupId), eq(knowledgeItems.relPath, fromRelPath)))
      .run()
  }

  countBySection(sectionId: string): number {
    const row = this.db
      .select({ value: sql<number>`count(*)` })
      .from(knowledgeItems)
      .where(eq(knowledgeItems.sectionId, sectionId))
      .get()
    return row?.value ?? 0
  }
}
