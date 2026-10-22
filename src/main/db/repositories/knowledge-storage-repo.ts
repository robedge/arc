import { eq, isNotNull } from 'drizzle-orm'
import { z } from 'zod'
import type { DbHandle } from '../client'
import { knowledgeStorage } from '../schema'
import type { KnowledgeStorageRow, NewKnowledgeStorageRow } from '../schema'

export type { KnowledgeStorageRow, NewKnowledgeStorageRow }

export const pendingOpKinds = [
  'link-move',
  'link-folder-only',
  'unlink-copy-back',
  'unlink-restore'
] as const

export const pendingOpSchema = z.object({
  kind: z.enum(pendingOpKinds),
  /** Root the operation reads from (the folder being emptied or copied). */
  sourceRoot: z.string().min(1),
  /** Root the operation writes to. */
  targetRoot: z.string().min(1),
  /** Path of the on-disk run manifest used for rollback, when one exists. */
  manifestPath: z.string().min(1).nullable().default(null),
  /** Files created by this run so far, for rollback when no manifest file is used. */
  createdFiles: z.array(z.string()).default([]),
  startedAt: z.number().int().nonnegative()
})

export type PendingOp = z.infer<typeof pendingOpSchema>
export type PendingOpInput = z.input<typeof pendingOpSchema>

/** One row with a pending_op set; `op` is null when the stored JSON no longer parses. */
export interface PendingOpEntry {
  groupId: string
  op: PendingOp | null
  raw: string
}

export type StorageFlip =
  { mode: 'app'; keptAside: boolean } | { mode: 'linked'; linkedPath: string; keptAside: boolean }

export class PendingOpConflictError extends Error {
  constructor(groupId: string) {
    super(`A storage operation is already pending for group ${groupId}`)
    this.name = 'PendingOpConflictError'
  }
}

export class StorageRowNotFoundError extends Error {
  constructor(groupId: string) {
    super(`No knowledge_storage row for group ${groupId}`)
    this.name = 'StorageRowNotFoundError'
  }
}

function parsePendingOp(raw: string): PendingOp | null {
  try {
    const result = pendingOpSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

export class KnowledgeStorageRepo {
  constructor(private readonly db: DbHandle) {}

  get(groupId: string): KnowledgeStorageRow | undefined {
    return this.db
      .select()
      .from(knowledgeStorage)
      .where(eq(knowledgeStorage.groupId, groupId))
      .get()
  }

  insert(row: NewKnowledgeStorageRow): void {
    this.db.insert(knowledgeStorage).values(row).run()
  }

  update(
    groupId: string,
    fields: Partial<Omit<KnowledgeStorageRow, 'groupId'>> & { updatedAt: number }
  ): void {
    this.db.update(knowledgeStorage).set(fields).where(eq(knowledgeStorage.groupId, groupId)).run()
  }

  /**
   * Records an in-progress storage operation. Throws PendingOpConflictError when one is already
   * set (even a corrupt one), and StorageRowNotFoundError when the group has no storage row.
   * The check and write run in one transaction.
   */
  beginPendingOp(groupId: string, input: PendingOpInput, now: number = Date.now()): PendingOp {
    const op = pendingOpSchema.parse(input)
    this.db.transaction((tx) => {
      const row = new KnowledgeStorageRepo(tx).get(groupId)
      if (!row) throw new StorageRowNotFoundError(groupId)
      if (row.pendingOp !== null) throw new PendingOpConflictError(groupId)
      tx.update(knowledgeStorage)
        .set({ pendingOp: JSON.stringify(op), updatedAt: now })
        .where(eq(knowledgeStorage.groupId, groupId))
        .run()
    })
    return op
  }

  /** The pending operation for a group, or null. Null also covers an unparseable marker; use listPendingOps to see those. */
  getPendingOp(groupId: string): PendingOp | null {
    const raw = this.get(groupId)?.pendingOp
    return raw ? parsePendingOp(raw) : null
  }

  /** Replaces the pending operation in place (for example to extend createdFiles). Throws if none is pending. */
  updatePendingOp(groupId: string, input: PendingOpInput, now: number = Date.now()): PendingOp {
    const op = pendingOpSchema.parse(input)
    this.db.transaction((tx) => {
      const row = new KnowledgeStorageRepo(tx).get(groupId)
      if (!row) throw new StorageRowNotFoundError(groupId)
      if (row.pendingOp === null) throw new Error(`No pending operation for group ${groupId}`)
      tx.update(knowledgeStorage)
        .set({ pendingOp: JSON.stringify(op), updatedAt: now })
        .where(eq(knowledgeStorage.groupId, groupId))
        .run()
    })
    return op
  }

  /** Clears the marker. Idempotent. */
  clearPendingOp(groupId: string, now: number = Date.now()): void {
    this.update(groupId, { pendingOp: null, updatedAt: now })
  }

  /** Every group with a pending marker, for startup recovery. */
  listPendingOps(): PendingOpEntry[] {
    return this.db
      .select({ groupId: knowledgeStorage.groupId, raw: knowledgeStorage.pendingOp })
      .from(knowledgeStorage)
      .where(isNotNull(knowledgeStorage.pendingOp))
      .all()
      .flatMap((r) =>
        r.raw === null ? [] : [{ groupId: r.groupId, raw: r.raw, op: parsePendingOp(r.raw) }]
      )
  }

  /** Whether in-app knowledge is kept aside in knowledge.kept/, and since when. The path is derived from the group id. */
  getKeptAside(groupId: string): { keptAside: boolean; since: number | null } | undefined {
    const row = this.get(groupId)
    return row ? { keptAside: row.keptAside, since: row.keptAsideAt } : undefined
  }

  setKeptAside(groupId: string, now: number = Date.now()): void {
    this.update(groupId, { keptAside: true, keptAsideAt: now, updatedAt: now })
  }

  clearKeptAside(groupId: string, now: number = Date.now()): void {
    this.update(groupId, { keptAside: false, keptAsideAt: null, updatedAt: now })
  }

  /**
   * The "database flip": in one transaction sets mode and linked_path, sets or clears kept_aside,
   * and clears pending_op. Keeps kept_aside_at when it was already set and stays set.
   */
  flipStorage(groupId: string, target: StorageFlip, now: number = Date.now()): void {
    this.db.transaction((tx) => {
      const row = new KnowledgeStorageRepo(tx).get(groupId)
      if (!row) throw new StorageRowNotFoundError(groupId)
      const keptAsideAt = target.keptAside ? (row.keptAside ? (row.keptAsideAt ?? now) : now) : null
      tx.update(knowledgeStorage)
        .set({
          mode: target.mode,
          linkedPath: target.mode === 'linked' ? target.linkedPath : null,
          keptAside: target.keptAside,
          keptAsideAt,
          pendingOp: null,
          updatedAt: now
        })
        .where(eq(knowledgeStorage.groupId, groupId))
        .run()
    })
  }
}
