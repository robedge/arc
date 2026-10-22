import { readFile, stat } from 'node:fs/promises'
import type { KnowledgeStorageRepo } from '../db/repositories/knowledge-storage-repo'
import type { PendingOp } from '../db/repositories/knowledge-storage-repo'
import {
  defaultFs,
  groupDirs,
  rollbackManifest,
  undoStorageDirs
} from './knowledge-storage-service'
import type { FsOps, StorageManifest } from './knowledge-storage-service'

/**
 * Startup recovery for interrupted storage operations. Runs once, before any window loads data.
 *
 * A set `pending_op` means the database flip never happened (the flip clears the marker in the
 * same transaction), so the database still describes the pre-operation state and recovery ROLLS
 * BACK the disk to it. The flip is the commit point; nothing is ever rolled forward, because the
 * source (linked folder or kept-aside knowledge) may have changed since.
 *
 * | kind               | crash point                          | recovery                                          |
 * |--------------------|--------------------------------------|---------------------------------------------------|
 * | link-move          | before/while copying, meta, verify   | delete the files and folders in the manifest,     |
 * |                    |                                      | restore meta.json; app `knowledge/` is untouched  |
 * | link-folder-only   | before/after the rename to           | move `knowledge.kept/` back to `knowledge/`       |
 * |                    | `knowledge.kept/`, folders created   | (partial cross-volume copy: the fuller tree wins);|
 * |                    |                                      | remove folders from the manifest                  |
 * | unlink-copy-back   | while staging, verified, swapped     | remove `knowledge.tmp/` and the stale             |
 * |                    |                                      | `knowledge/`; `knowledge.discarded/` returns to   |
 * |                    |                                      | `knowledge.kept/`; linked folder never touched    |
 * | unlink-restore     | before the flip, tree already moved  | move the tree back to `knowledge.kept/`           |
 * | corrupt marker     | unknown                              | remove staging, apply manifest if one parses, and |
 * |                    |                                      | repair only the unambiguous folder moves          |
 *
 * After the marker is handled (and for groups with no marker) a sweep removes what can never be
 * valid on its own: `knowledge.tmp/` (staging), `knowledge.discarded/` (the flip committed, so the
 * discard is finished), and an orphaned `storage-op.json`. `knowledge.kept/` is never deleted
 * without a marker: with `kept_aside=0` it is only logged; with `kept_aside=1` but no folder the
 * flag is cleared so the UI does not offer a restore that cannot work.
 *
 * Limits: the link manifest is flushed every 25 copies, so a hard crash can leave up to 24 copied
 * files in the chosen folder that the manifest does not list. They are complete copies of app
 * knowledge, so nothing is lost; they are not removed.
 *
 * A failure for one group is logged and its marker kept (the UI reports STORAGE_OP_PENDING) so the
 * next start retries.
 */
export interface StorageRecoveryDeps {
  storageRepo: Pick<
    KnowledgeStorageRepo,
    'get' | 'listPendingOps' | 'clearPendingOp' | 'clearKeptAside'
  >
  listGroupIds: () => string[]
  appDataDir: string
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  fs?: Partial<FsOps>
}

export interface RecoveryAction {
  groupId: string
  kind: PendingOp['kind'] | 'corrupt' | 'sweep'
  outcome: 'rolled-back' | 'cleaned' | 'failed'
  detail: string
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

async function readManifest(path: string): Promise<StorageManifest | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as StorageManifest).version === 1 &&
      typeof (parsed as StorageManifest).targetRoot === 'string' &&
      Array.isArray((parsed as StorageManifest).createdFiles) &&
      Array.isArray((parsed as StorageManifest).createdDirs)
    ) {
      return parsed as StorageManifest
    }
  } catch {
    // missing or unreadable manifest: nothing to roll back from it
  }
  return null
}

export async function recoverStorage(deps: StorageRecoveryDeps): Promise<RecoveryAction[]> {
  const { storageRepo, log } = deps
  const fs: FsOps = { ...defaultFs, ...deps.fs }
  const actions: RecoveryAction[] = []
  const failed = new Set<string>()

  for (const entry of storageRepo.listPendingOps()) {
    const { groupId, op } = entry
    const kind = op?.kind ?? null
    const dirs = groupDirs(deps.appDataDir, groupId)
    try {
      const row = storageRepo.get(groupId)
      if (!row) throw new Error('no knowledge_storage row')
      const details: string[] = []
      if (kind === null || kind === 'link-move' || kind === 'link-folder-only') {
        const manifest = await readManifest(op?.manifestPath ?? dirs.manifest)
        if (manifest && (await exists(manifest.targetRoot))) {
          await rollbackManifest(manifest, fs)
          details.push(
            `rolled back ${manifest.createdFiles.length} files and ${manifest.createdDirs.length} folders in ${manifest.targetRoot}`
          )
        } else if (kind !== 'link-folder-only') {
          details.push('no usable manifest or target folder; created files (if any) left in place')
        }
      }
      details.push(await undoStorageDirs(kind, dirs, row, fs))
      await fs.rm(dirs.tmp, { recursive: true, force: true })
      await fs.rm(op?.manifestPath ?? dirs.manifest, { force: true })
      storageRepo.clearPendingOp(groupId)
      const action: RecoveryAction = {
        groupId,
        kind: kind ?? 'corrupt',
        outcome: 'rolled-back',
        detail: details.join('; ')
      }
      actions.push(action)
      log.info(`storage recovery: group ${groupId} ${action.kind}: ${action.detail}`)
    } catch (error: unknown) {
      failed.add(groupId)
      actions.push({
        groupId,
        kind: kind ?? 'corrupt',
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      })
      log.error(`storage recovery failed for group ${groupId}; keeping the marker`, error)
    }
  }

  for (const groupId of deps.listGroupIds()) {
    if (failed.has(groupId)) continue
    const row = storageRepo.get(groupId)
    if (!row || row.pendingOp !== null) continue
    const dirs = groupDirs(deps.appDataDir, groupId)
    const done: string[] = []
    try {
      for (const [label, path] of [
        ['knowledge.tmp/', dirs.tmp],
        ['knowledge.discarded/', dirs.discarded],
        ['storage-op.json', dirs.manifest]
      ] as const) {
        if (await exists(path)) {
          await fs.rm(path, { recursive: true, force: true })
          done.push(`removed leftover ${label}`)
        }
      }
      const keptExists = await exists(dirs.kept)
      if (!row.keptAside && keptExists) {
        log.warn(
          `storage recovery: group ${groupId} has knowledge.kept/ but kept_aside is off; leaving it untouched`
        )
      } else if (row.keptAside && !keptExists) {
        storageRepo.clearKeptAside(groupId)
        done.push('cleared kept_aside: knowledge.kept/ is missing')
      }
    } catch (error: unknown) {
      actions.push({
        groupId,
        kind: 'sweep',
        outcome: 'failed',
        detail: error instanceof Error ? error.message : String(error)
      })
      log.error(`storage recovery sweep failed for group ${groupId}`, error)
      continue
    }
    if (done.length > 0) {
      actions.push({ groupId, kind: 'sweep', outcome: 'cleaned', detail: done.join('; ') })
      log.info(`storage recovery: group ${groupId}: ${done.join('; ')}`)
    }
  }
  return actions
}
