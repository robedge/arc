import { and, asc, eq, gte, max } from 'drizzle-orm'
import { CUSTOM_SECTION_SORT_START } from '@shared/sections'
import type { DbHandle } from '../client'
import { sections } from '../schema'
import type { NewSectionRow, SectionRow } from '../schema'

export type { NewSectionRow, SectionRow }

export class SectionsRepo {
  constructor(private readonly db: DbHandle) {}

  listByGroup(groupId: string): SectionRow[] {
    return this.db
      .select()
      .from(sections)
      .where(eq(sections.groupId, groupId))
      .orderBy(asc(sections.sortOrder), asc(sections.createdAt))
      .all()
  }

  getById(id: string): SectionRow | undefined {
    return this.db.select().from(sections).where(eq(sections.id, id)).get()
  }

  getByGroupAndNameKey(groupId: string, nameKey: string): SectionRow | undefined {
    return this.db
      .select()
      .from(sections)
      .where(and(eq(sections.groupId, groupId), eq(sections.nameKey, nameKey)))
      .get()
  }

  /** Throws the raw SQLite error on a unique violation; use `isUniqueViolation` to detect it. */
  insert(row: NewSectionRow): void {
    this.db.insert(sections).values(row).run()
  }

  /** Throws the raw SQLite error on a duplicate name_key; use `isUniqueViolation` to detect it. */
  update(id: string, fields: { name: string; nameKey: string; folderName: string | null }): void {
    this.db.update(sections).set(fields).where(eq(sections.id, id)).run()
  }

  delete(id: string): void {
    this.db.delete(sections).where(eq(sections.id, id)).run()
  }

  /** Highest sort_order among the group's custom sections, or null when it has none. */
  maxCustomSortOrder(groupId: string): number | null {
    const row = this.db
      .select({ value: max(sections.sortOrder) })
      .from(sections)
      .where(and(eq(sections.groupId, groupId), gte(sections.sortOrder, CUSTOM_SECTION_SORT_START)))
      .get()
    return row?.value ?? null
  }
}
