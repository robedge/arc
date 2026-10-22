import { randomUUID } from 'node:crypto'
import {
  access,
  constants as fsConstants,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  stat
} from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { AppErrorException } from '@shared/errors'
import type { ErrorCode } from '@shared/errors'
import type { IpcEvents } from '@shared/ipc/contract'
import { sectionNameKey } from '@shared/sections'
import type {
  StorageBlockedReason,
  StorageExportPickResult,
  StorageExportResult,
  StorageLinkChoice,
  StorageLocateResult,
  StoragePickResult,
  StorageProgressPhase,
  StorageState,
  StorageUnlinkChoice
} from '@shared/types/storage'
import type { GroupsRepo } from '../db/repositories/groups-repo'
import { PendingOpConflictError } from '../db/repositories/knowledge-storage-repo'
import type {
  KnowledgeStorageRepo,
  KnowledgeStorageRow,
  PendingOp
} from '../db/repositories/knowledge-storage-repo'
import type { ProjectsRepo } from '../db/repositories/projects-repo'
import type { SectionsRepo } from '../db/repositories/sections-repo'
import { isAvailable } from '../groups/project-service'
import type { Dialogs } from '../platform/dialogs'
import { atomicWriteFile } from './atomic-write'
import { copyAndVerify, exportFolderName } from './knowledge-export'
import { resolveInRoot, uniqueName } from './knowledge-paths'
import type { MetaStore } from './meta-store'

export const PICK_TOKEN_TTL_MS = 10 * 60 * 1000
const MANIFEST_FLUSH_EVERY = 25
const PROGRESS_EVERY = 10
const MANIFEST_NAME = 'storage-op.json'
const KEPT_DIR = 'knowledge.kept'
/** Unlink copy-back staging. Always garbage when found without a running operation. */
export const TMP_DIR = 'knowledge.tmp'
/** Kept-aside knowledge that keep-current is about to discard; deleted once the flip commits. */
export const DISCARDED_DIR = 'knowledge.discarded'
export const MANIFEST_FILE = MANIFEST_NAME
const META_DIR = '.arc'

/** The fs calls whose failure matters to the operation; injectable so tests can fail them. */
export interface FsOps {
  copyFile(src: string, dest: string, mode?: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { recursive?: boolean; force?: boolean }): Promise<void>
  rmdir(path: string): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  stat(path: string): Promise<{ size: number; mtimeMs: number }>
}

export const defaultFs: FsOps = {
  copyFile: (src, dest, mode) => copyFile(src, dest, mode),
  rename,
  rm,
  rmdir,
  mkdir: async (path, options) => {
    await mkdir(path, options)
  },
  stat
}

export interface StorageWatcher {
  readonly watchedGroupId: string | null
  pause(): void
  resume(): Promise<void>
  start(groupId: string): Promise<void>
}

export interface KnowledgeStorageServiceDeps {
  storageRepo: Pick<
    KnowledgeStorageRepo,
    'get' | 'beginPendingOp' | 'clearPendingOp' | 'flipStorage'
  >
  projectsRepo: Pick<ProjectsRepo, 'listByGroup'>
  sectionsRepo: Pick<SectionsRepo, 'listByGroup' | 'update' | 'delete'>
  metaStore: Pick<MetaStore, 'read' | 'updateMeta' | 'metaPath'>
  dialogs: Pick<Dialogs, 'pickFolders'>
  groupsRepo: Pick<GroupsRepo, 'getById'>
  watcher: StorageWatcher
  index: { reconcileGroup(groupId: string): Promise<void> }
  adoptFolders: (groupId: string) => Promise<unknown>
  listGroupIds: () => string[]
  appDataDir: string
  emit: <E extends 'knowledge:changed' | 'storage:progress'>(
    event: E,
    payload: IpcEvents[E]
  ) => void
  log?: {
    info?: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error?: (...args: unknown[]) => void
  }
  fs?: Partial<FsOps>
  now?: () => number
  newToken?: () => string
}

/** Everything a rollback needs. Paths are relative to `targetRoot`, '/'-separated. */
export interface StorageManifest {
  version: 1
  targetRoot: string
  createdFiles: string[]
  createdDirs: string[]
  /** meta.json before the merge: null = it did not exist; undefined = not touched yet. */
  metaBackup?: string | null
}

export interface PreflightResult {
  /** Canonical path (realpath) of the chosen folder. */
  path: string
  blocked: StorageBlockedReason | null
  hasKnowledge: boolean
  targetHasContent: boolean
  insideProjectRepo: { projectId: string; projectName: string } | null
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

function isInside(child: string, parent: string): boolean {
  const c = fold(child)
  const p = fold(parent)
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** realpath of the nearest existing ancestor plus the not-yet-existing remainder. */
async function canonical(path: string): Promise<string> {
  const abs = resolve(path)
  let current = abs
  const rest: string[] = []
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse())
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return abs
      rest.push(basename(current))
      current = parent
    }
  }
}

function toRel(segments: readonly string[]): string {
  return segments.join('/')
}

async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** Regular files below `root`, skipping dot entries. Stops early once `limit` is reached. */
async function countFiles(root: string, limit = Number.POSITIVE_INFINITY): Promise<number> {
  let count = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdirSafe(dir)) {
      if (count >= limit) return
      if (entry.name.startsWith('.')) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) count++
    }
  }
  await walk(root)
  return count
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/**
 * Rolls back a failed link run: removes exactly the files and directories the run created
 * (directories only when empty) and restores meta.json. Safe to call twice. Exported for startup
 * recovery.
 */
export async function rollbackManifest(
  manifest: StorageManifest,
  fs: Pick<FsOps, 'rm' | 'rmdir'> = defaultFs,
  metaPath: string = join(manifest.targetRoot, META_DIR, 'meta.json')
): Promise<void> {
  for (const rel of [...manifest.createdFiles].reverse()) {
    const abs = await resolveInRoot(manifest.targetRoot, rel.split('/'), { allowMetaDir: true })
    await fs.rm(abs, { force: true })
  }
  if (manifest.metaBackup === null) {
    await fs.rm(metaPath, { force: true })
  } else if (manifest.metaBackup !== undefined) {
    await atomicWriteFile(metaPath, manifest.metaBackup)
  }
  for (const rel of [...manifest.createdDirs].reverse()) {
    const abs = await resolveInRoot(manifest.targetRoot, rel.split('/'), { allowMetaDir: true })
    await fs.rmdir(abs).catch(() => undefined) // not empty = someone else's files; leave it
  }
}

/**
 * Moves a directory to a path that does not exist. Tries rename; across volumes (EXDEV) it
 * copies the tree, verifies file counts and sizes, then deletes the source. A failed copy removes
 * the partial destination and leaves the source untouched.
 */
export async function moveDirectory(
  src: string,
  dest: string,
  fs: FsOps = defaultFs
): Promise<void> {
  try {
    await fs.rename(src, dest)
    return
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }
  const copied: { from: string; to: string; size: number }[] = []
  async function copyDir(from: string, to: string): Promise<void> {
    await fs.mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const a = join(from, entry.name)
      const b = join(to, entry.name)
      if (entry.isDirectory()) await copyDir(a, b)
      else if (entry.isFile()) {
        await fs.copyFile(a, b, fsConstants.COPYFILE_EXCL)
        copied.push({ from: a, to: b, size: (await fs.stat(a)).size })
      }
    }
  }
  try {
    await copyDir(src, dest)
    for (const file of copied) {
      if ((await fs.stat(file.to)).size !== file.size) throw new Error(`verify failed: ${file.to}`)
    }
  } catch (error: unknown) {
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  await fs.rm(src, { recursive: true, force: true })
}

/** Every regular file below `root`, hidden entries included (so `.arc/` counts). */
async function countAllFiles(root: string): Promise<number> {
  let count = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdirSafe(dir)) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) await walk(abs)
      else if (entry.isFile()) count++
    }
  }
  await walk(root)
  return count
}

/**
 * Makes sure one complete tree ends up at `finalPath`, given a move between `finalPath` and
 * `otherPath` that may have been interrupted. Only one exists: it is moved to `finalPath`. Both
 * exist (a cross-volume move stopped part way): the one with more files is the complete one, since
 * the source is only deleted after the copy is verified and the destination only grows while
 * copying; a tie keeps `finalPath`. Neither exists: 'lost'.
 */
export async function settleSplit(
  finalPath: string,
  otherPath: string,
  fs: FsOps = defaultFs
): Promise<'ok' | 'lost'> {
  const [hasFinal, hasOther] = await Promise.all([isDirectory(finalPath), isDirectory(otherPath)])
  if (!hasFinal && !hasOther) return 'lost'
  if (hasFinal && hasOther) {
    const [inFinal, inOther] = await Promise.all([
      countAllFiles(finalPath),
      countAllFiles(otherPath)
    ])
    if (inOther > inFinal) {
      await fs.rm(finalPath, { recursive: true, force: true })
      await moveDirectory(otherPath, finalPath, fs)
    } else {
      await fs.rm(otherPath, { recursive: true, force: true })
    }
  } else if (hasOther) {
    await moveDirectory(otherPath, finalPath, fs)
  }
  return 'ok'
}

/** The group's app-managed folders. */
export interface GroupDirs {
  /** `knowledge/`: authoritative in app mode, stale garbage in linked mode. */
  app: string
  /** `knowledge.kept/`: earlier in-app knowledge set aside by "Use the folder's contents only". */
  kept: string
  tmp: string
  discarded: string
  manifest: string
}

export function groupDirs(appDataDir: string, groupId: string): GroupDirs {
  const base = join(appDataDir, 'groups', groupId)
  return {
    app: join(base, 'knowledge'),
    kept: join(base, KEPT_DIR),
    tmp: join(base, TMP_DIR),
    discarded: join(base, DISCARDED_DIR),
    manifest: join(base, MANIFEST_NAME)
  }
}

/**
 * Puts the group's app folders back the way the (unflipped) database says they should be, for a
 * run that did not reach the flip. Shared by in-process rollback and startup recovery. `kind` is
 * null for a corrupt marker, where only the unambiguous cases are repaired. Returns a log line.
 *
 *  - link-move: nothing (the source `knowledge/` is untouched until after the flip).
 *  - link-folder-only: the tree belongs at `knowledge/`; undo the rename to `knowledge.kept/`.
 *  - unlink-copy-back: drop the staging folder and the stale `knowledge/`; if the kept-aside folder
 *    was moved to `knowledge.discarded/`, move it back to `knowledge.kept/`.
 *  - unlink-restore: the tree belongs at `knowledge.kept/`; undo the rename to `knowledge/`.
 */
export async function undoStorageDirs(
  kind: PendingOp['kind'] | null,
  dirs: GroupDirs,
  row: { mode: 'app' | 'linked'; keptAside: boolean },
  fs: FsOps = defaultFs
): Promise<string> {
  const rmTree = (path: string): Promise<void> => fs.rm(path, { recursive: true, force: true })
  switch (kind) {
    case 'link-move':
      return 'source left in place'
    case 'link-folder-only':
      return (await settleSplit(dirs.app, dirs.kept, fs)) === 'ok'
        ? 'knowledge restored to knowledge/'
        : 'knowledge folder missing'
    case 'unlink-copy-back': {
      await rmTree(dirs.tmp)
      await rmTree(dirs.app)
      if (await isDirectory(dirs.discarded)) {
        return (await settleSplit(dirs.kept, dirs.discarded, fs)) === 'ok'
          ? 'staging removed, kept-aside knowledge put back'
          : 'staging removed'
      }
      return 'staging removed'
    }
    case 'unlink-restore':
      return (await settleSplit(dirs.kept, dirs.app, fs)) === 'ok'
        ? 'kept-aside knowledge put back in knowledge.kept/'
        : 'kept-aside knowledge missing'
    case null: {
      await rmTree(dirs.tmp)
      const [hasApp, hasKept, hasDiscarded] = await Promise.all([
        isDirectory(dirs.app),
        isDirectory(dirs.kept),
        isDirectory(dirs.discarded)
      ])
      if (row.mode === 'app' && hasKept && !hasApp) {
        await moveDirectory(dirs.kept, dirs.app, fs)
        return 'corrupt marker: moved knowledge.kept/ back to knowledge/'
      }
      if (row.mode === 'linked' && row.keptAside && !hasKept) {
        if (hasDiscarded) {
          await moveDirectory(dirs.discarded, dirs.kept, fs)
          return 'corrupt marker: moved knowledge.discarded/ back to knowledge.kept/'
        }
        if (hasApp) {
          await moveDirectory(dirs.app, dirs.kept, fs)
          return 'corrupt marker: moved knowledge/ back to knowledge.kept/'
        }
      }
      return 'corrupt marker: nothing to repair'
    }
  }
}

interface RunContext {
  groupId: string
  sourceRoot: string
  targetRoot: string
  manifestPath: string
  manifest: StorageManifest
  total: number
  done: number
  copied: { src: string; dest: string; size: number; mtimeMs: number }[]
  /** source relPath -> relPath it got in the target. */
  relMap: Map<string, string>
  /** folded top-level folder name -> the folder's actual name in the target. */
  topFolders: Map<string, string>
  unflushed: number
}

export class KnowledgeStorageService {
  private readonly fs: FsOps
  private readonly locks = new Set<string>()
  private readonly exportPicks = new Map<
    string,
    { groupId: string; path: string; expiresAt: number }
  >()
  private readonly picks = new Map<string, { groupId: string; path: string; expiresAt: number }>()
  private readonly now: () => number
  private readonly newToken: () => string
  private readonly warn: (...args: unknown[]) => void

  constructor(private readonly deps: KnowledgeStorageServiceDeps) {
    this.fs = { ...defaultFs, ...deps.fs }
    this.now = deps.now ?? Date.now
    this.newToken = deps.newToken ?? randomUUID
    this.warn = (...args) => deps.log?.warn(...args)
  }

  // ---- lock -------------------------------------------------------------------------------

  /** Runs `task` as the only storage operation for the group; a concurrent one gets STORAGE_BUSY. */
  async withLock<T>(groupId: string, task: () => Promise<T>): Promise<T> {
    if (this.locks.has(groupId)) throw new AppErrorException('STORAGE_BUSY')
    this.locks.add(groupId)
    try {
      return await task()
    } finally {
      this.locks.delete(groupId)
    }
  }

  isLocked(groupId: string): boolean {
    return this.locks.has(groupId)
  }

  // ---- paths --------------------------------------------------------------------------------

  appKnowledgeRoot(groupId: string): string {
    return join(this.deps.appDataDir, 'groups', groupId, 'knowledge')
  }

  keptAsidePath(groupId: string): string {
    return join(this.deps.appDataDir, 'groups', groupId, KEPT_DIR)
  }

  private manifestPathFor(groupId: string): string {
    return join(this.deps.appDataDir, 'groups', groupId, MANIFEST_NAME)
  }

  private currentRoot(groupId: string): string {
    const row = this.deps.storageRepo.get(groupId)
    if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    return row.mode === 'linked' && row.linkedPath ? row.linkedPath : this.appKnowledgeRoot(groupId)
  }

  // ---- state / pick / preflight -----------------------------------------------------------------

  async getState(groupId: string): Promise<StorageState> {
    const row = this.deps.storageRepo.get(groupId)
    if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    const linked = row.mode === 'linked' && row.linkedPath !== null
    const root = this.currentRoot(groupId)
    const available = linked ? await isAvailable(root) : true
    return {
      mode: linked ? 'linked' : 'app',
      linkedPath: linked ? root : null,
      keptAside: row.keptAside,
      available,
      hasKnowledge: available ? (await countFiles(root, 1)) > 0 : false
    }
  }

  /** Opens the native folder picker, preflights the choice and issues a single-use token. */
  async pickFolder(groupId: string): Promise<StoragePickResult> {
    this.requireAppMode(groupId)
    const chosen = await this.deps.dialogs.pickFolders({ multi: false })
    const first = chosen?.[0]
    if (!first) return { picked: false }
    const result = await this.preflight(groupId, first)
    let token: string | null = null
    if (result.blocked === null) {
      token = this.newToken()
      this.picks.set(token, {
        groupId,
        path: result.path,
        expiresAt: this.now() + PICK_TOKEN_TTL_MS
      })
    }
    return { picked: true, ...result, token }
  }

  async preflight(groupId: string, rawPath: string): Promise<PreflightResult> {
    let path: string
    try {
      path = await realpath(rawPath)
    } catch {
      return this.blockedResult(resolve(rawPath), 'not-a-folder')
    }
    if (!(await isDirectory(path))) return this.blockedResult(path, 'not-a-folder')

    const nested = await this.nestingReason(groupId, path)
    if (nested) return this.blockedResult(path, nested)
    try {
      await access(path, fsConstants.W_OK)
    } catch {
      return this.blockedResult(path, 'not-writable')
    }

    const entries = (await readdirSafe(path)).filter((e) => !e.name.startsWith('.'))
    let repo: PreflightResult['insideProjectRepo'] = null
    for (const project of this.deps.projectsRepo.listByGroup(groupId)) {
      if (!project.isGit) continue
      if (isInside(path, await canonical(project.path))) {
        repo = { projectId: project.id, projectName: project.displayName }
        break
      }
    }
    return {
      path,
      blocked: null,
      hasKnowledge: (await countFiles(this.currentRoot(groupId), 1)) > 0,
      targetHasContent: entries.length > 0,
      insideProjectRepo: repo
    }
  }

  private blockedResult(path: string, blocked: StorageBlockedReason): PreflightResult {
    return {
      path,
      blocked,
      hasKnowledge: false,
      targetHasContent: false,
      insideProjectRepo: null
    }
  }

  /** Nesting with app storage (all groups' app folders) or another group's linked root, either way. */
  private async nestingReason(groupId: string, path: string): Promise<StorageBlockedReason | null> {
    const appStorage = await canonical(join(this.deps.appDataDir, 'groups'))
    if (isInside(path, appStorage)) return 'inside-app-storage'
    if (isInside(appStorage, path)) return 'contains-app-storage'
    for (const otherId of this.deps.listGroupIds()) {
      if (otherId === groupId) continue
      const other = this.deps.storageRepo.get(otherId)
      if (other?.mode !== 'linked' || !other.linkedPath) continue
      const otherRoot = await canonical(other.linkedPath)
      if (isInside(path, otherRoot)) return 'inside-other-group'
      if (isInside(otherRoot, path)) return 'contains-other-group'
    }
    return null
  }

  private requireAppMode(groupId: string): void {
    const row = this.deps.storageRepo.get(groupId)
    if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    if (row.mode === 'linked') throw new AppErrorException('STORAGE_ALREADY_LINKED')
  }

  // ---- export -------------------------------------------------------------------------------------

  /** Opens the native folder picker for an export destination and issues a single-use token. */
  async pickExportFolder(groupId: string): Promise<StorageExportPickResult> {
    if (!this.deps.storageRepo.get(groupId)) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    const chosen = await this.deps.dialogs.pickFolders({ multi: false })
    const first = chosen?.[0]
    if (!first) return { picked: false }
    const pre = await this.preflight(groupId, first)
    let blocked = pre.blocked
    if (blocked === null) {
      const root = await canonical(this.currentRoot(groupId))
      if (pre.path === root || isInside(pre.path, root)) blocked = 'inside-app-storage'
    }
    let token: string | null = null
    if (blocked === null) {
      token = this.newToken()
      this.exportPicks.set(token, {
        groupId,
        path: pre.path,
        expiresAt: this.now() + PICK_TOKEN_TTL_MS
      })
    }
    return { picked: true, path: pre.path, blocked, token }
  }

  /**
   * Consumes an export token and copies the group's whole knowledge root (including `.arc/`) to a
   * new `<group name>-knowledge` folder (unique name) inside the picked folder, then verifies the
   * file count and sizes. On any failure the partial folder is removed and EXPORT_FAILED is thrown.
   * The source is only read, so it works for app-stored and linked groups alike.
   */
  async exportKnowledge(groupId: string, token: string): Promise<StorageExportResult> {
    const pick = this.exportPicks.get(token)
    this.exportPicks.delete(token)
    if (!pick || pick.groupId !== groupId || pick.expiresAt <= this.now()) {
      throw new AppErrorException('STORAGE_TARGET_INVALID')
    }
    return this.withLock(groupId, async () => {
      const row = this.deps.storageRepo.get(groupId)
      if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
      if (row.pendingOp !== null) throw new AppErrorException('STORAGE_OP_PENDING')
      const group = this.deps.groupsRepo.getById(groupId)
      if (!group) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
      const source = this.currentRoot(groupId)
      if (!(await isDirectory(source))) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
      const pre = await this.preflight(groupId, pick.path)
      if (pre.blocked) throw new AppErrorException(blockedToCode(pre.blocked))

      const dest = await this.createExportFolder(pre.path, exportFolderName(group.name))
      const send = (
        phase: 'preparing' | 'exporting' | 'verifying',
        done: number,
        total: number
      ): void => this.deps.emit('storage:progress', { groupId, phase, done, total })
      try {
        const count = await copyAndVerify(source, dest, this.fs, send)
        this.deps.emit('storage:progress', { groupId, phase: 'done', done: count, total: count })
        return { count, path: dest }
      } catch (error: unknown) {
        await this.fs.rm(dest, { recursive: true, force: true }).catch((e: unknown) => {
          this.warn('export: could not remove the partial export', e)
        })
        this.warn('export failed', error)
        throw new AppErrorException('EXPORT_FAILED')
      }
    })
  }

  /** Creates a fresh, uniquely named folder; never reuses an existing one. */
  private async createExportFolder(parent: string, desired: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const names = (await readdirSafe(parent)).map((e) => e.name)
      const dest = join(parent, uniqueName(names, desired))
      try {
        await mkdir(dest)
        return dest
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
          throw new AppErrorException('EXPORT_FAILED')
      }
    }
    throw new AppErrorException('EXPORT_FAILED')
  }

  // ---- link -------------------------------------------------------------------------------------

  /** Consumes a `pickFolder` token and links that folder. */
  async link(groupId: string, token: string, choice: StorageLinkChoice): Promise<StorageState> {
    const pick = this.picks.get(token)
    this.picks.delete(token)
    if (!pick || pick.groupId !== groupId || pick.expiresAt <= this.now()) {
      throw new AppErrorException('STORAGE_TARGET_INVALID')
    }
    return this.linkPath(groupId, pick.path, choice)
  }

  /** Links `path` (re-runs the preflight, which is authoritative). */
  async linkPath(groupId: string, path: string, choice: StorageLinkChoice): Promise<StorageState> {
    await this.withLock(groupId, async () => {
      const row = this.deps.storageRepo.get(groupId)
      if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
      if (row.mode === 'linked') throw new AppErrorException('STORAGE_ALREADY_LINKED')
      if (row.pendingOp !== null) throw new AppErrorException('STORAGE_OP_PENDING')
      const pre = await this.preflight(groupId, path)
      if (pre.blocked) throw new AppErrorException(blockedToCode(pre.blocked))

      const source = this.appKnowledgeRoot(groupId)
      const wasWatching = this.deps.watcher.watchedGroupId === groupId
      if (wasWatching) this.deps.watcher.pause()
      let flipped = false
      try {
        const fileCount = await countFiles(source)
        if (choice === 'folder-only' && fileCount > 0) {
          if (row.keptAside && (await isDirectory(this.keptAsidePath(groupId)))) {
            throw new AppErrorException('STORAGE_KEPT_ASIDE_EXISTS')
          }
          await this.runFolderOnly(groupId, source, pre.path)
        } else {
          await this.runMove(groupId, source, pre.path, fileCount, row.keptAside)
        }
        flipped = true
      } finally {
        if (!flipped && wasWatching) await this.deps.watcher.resume().catch(() => undefined)
      }
      await this.afterFlip(groupId, wasWatching)
    })
    return this.getState(groupId)
  }

  private begin(groupId: string, op: Omit<PendingOp, 'startedAt' | 'createdFiles'>): void {
    try {
      this.deps.storageRepo.beginPendingOp(groupId, {
        ...op,
        createdFiles: [],
        startedAt: this.now()
      })
    } catch (error: unknown) {
      if (error instanceof PendingOpConflictError) {
        throw new AppErrorException('STORAGE_OP_PENDING')
      }
      throw error
    }
  }

  private newContext(
    groupId: string,
    sourceRoot: string,
    targetRoot: string,
    total: number
  ): RunContext {
    return {
      groupId,
      sourceRoot,
      targetRoot,
      manifestPath: this.manifestPathFor(groupId),
      manifest: { version: 1, targetRoot, createdFiles: [], createdDirs: [] },
      total,
      done: 0,
      copied: [],
      relMap: new Map(),
      topFolders: new Map(),
      unflushed: 0
    }
  }

  private async flush(ctx: RunContext): Promise<void> {
    await atomicWriteFile(ctx.manifestPath, JSON.stringify(ctx.manifest))
    ctx.unflushed = 0
  }

  private progress(ctx: RunContext, phase: StorageProgressPhase, force = false): void {
    if (!force && phase === 'copying' && ctx.done % PROGRESS_EVERY !== 0 && ctx.done < ctx.total) {
      return
    }
    this.deps.emit('storage:progress', {
      groupId: ctx.groupId,
      phase,
      done: ctx.done,
      total: ctx.total
    })
  }

  /** Undoes a failed run and clears the marker. If the undo itself fails the marker stays for recovery. */
  private async rollBack(ctx: RunContext, extraUndo?: () => Promise<void>): Promise<void> {
    this.progress(ctx, 'rolling-back', true)
    // Make the on-disk manifest complete first, so recovery can finish the job if this undo fails.
    await this.flush(ctx).catch(() => undefined)
    try {
      await extraUndo?.()
      await rollbackManifest(ctx.manifest, this.fs, this.deps.metaStore.metaPath(ctx.targetRoot))
    } catch (error: unknown) {
      this.deps.log?.error?.('storage rollback failed; leaving pending_op for recovery', error)
      throw new AppErrorException('IO_FAILED')
    }
    await this.fs.rm(ctx.manifestPath, { force: true }).catch(() => undefined)
    this.deps.storageRepo.clearPendingOp(ctx.groupId)
  }

  // ---- move-merge ---------------------------------------------------------------------------------

  /**
   * Failure policy. Before the database flip (copy, meta merge, verify, the flip itself) the run is
   * rolled back: exactly the files and folders it created are removed, meta.json is restored, the
   * source is untouched and the marker is cleared. After the flip the group is linked and the target
   * is complete, so a failure deleting the source is only logged: rolling back would be worse than
   * leaving a stale copy in the (now unused) app folder.
   */
  private async runMove(
    groupId: string,
    source: string,
    target: string,
    total: number,
    keptAside: boolean
  ): Promise<void> {
    const ctx = this.newContext(groupId, source, target, total)
    this.begin(groupId, {
      kind: 'link-move',
      sourceRoot: source,
      targetRoot: target,
      manifestPath: ctx.manifestPath
    })
    try {
      this.progress(ctx, 'preparing', true)
      await this.flush(ctx)
      await this.copyTree(ctx, source, [], [])
      await this.ensureSectionFolders(ctx)
      await this.mergeMeta(ctx)
      await this.flush(ctx)
      await this.verify(ctx)
      this.progress(ctx, 'switching', true)
      this.deps.storageRepo.flipStorage(groupId, { mode: 'linked', linkedPath: target, keptAside })
    } catch (error: unknown) {
      await this.rollBack(ctx)
      throw asAppError(error)
    }
    this.progress(ctx, 'cleaning', true)
    await this.emptyDirectory(source)
    await this.fs.rm(ctx.manifestPath, { force: true }).catch(() => undefined)
    this.syncFolderNames(groupId, ctx.topFolders)
    this.progress(ctx, 'done', true)
  }

  private async copyTree(
    ctx: RunContext,
    srcDir: string,
    srcRel: string[],
    destRel: string[]
  ): Promise<void> {
    const destAbs = join(ctx.targetRoot, ...destRel)
    const destEntries = await readdirSafe(destAbs)
    const destNames = new Set(destEntries.map((e) => e.name))
    const entries = (await readdir(srcDir, { withFileTypes: true }))
      .filter((e) => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const src = join(srcDir, entry.name)
      if (entry.isDirectory()) {
        const match = destEntries.find((d) => d.isDirectory() && fold(d.name) === fold(entry.name))
        let destName = match?.name
        if (destName === undefined) {
          destName = uniqueName(destNames, entry.name)
          await this.makeDir(ctx, [...destRel, destName])
          destNames.add(destName)
        }
        if (destRel.length === 0) ctx.topFolders.set(fold(entry.name), destName)
        await this.copyTree(ctx, src, [...srcRel, entry.name], [...destRel, destName])
      } else if (entry.isFile()) {
        await this.copyOne(ctx, src, [...srcRel, entry.name], destRel, entry.name, destNames)
      } else {
        this.warn(`link: skipping non-regular entry ${src}`)
      }
    }
  }

  private async copyOne(
    ctx: RunContext,
    src: string,
    srcRel: string[],
    destRel: string[],
    name: string,
    destNames: Set<string>
  ): Promise<void> {
    const info = await lstat(src)
    for (let attempt = 0; ; attempt++) {
      const destName = uniqueName(destNames, name)
      const segments = [...destRel, destName]
      const dest = await resolveInRoot(ctx.targetRoot, segments)
      try {
        await this.fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL)
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST' && attempt < 3) {
          destNames.add(destName) // appeared since we listed; pick another name
          continue
        }
        throw error
      }
      destNames.add(destName)
      ctx.manifest.createdFiles.push(toRel(segments))
      ctx.relMap.set(toRel(srcRel), toRel(segments))
      ctx.copied.push({ src, dest, size: info.size, mtimeMs: info.mtimeMs })
      ctx.done++
      if (++ctx.unflushed >= MANIFEST_FLUSH_EVERY) await this.flush(ctx)
      this.progress(ctx, 'copying')
      return
    }
  }

  private async makeDir(ctx: RunContext, segments: string[]): Promise<void> {
    const abs = await resolveInRoot(ctx.targetRoot, segments, { allowMetaDir: true })
    await this.fs.mkdir(abs, { recursive: false })
    ctx.manifest.createdDirs.push(toRel(segments))
    await this.flush(ctx)
  }

  /** Every section in the registry gets its folder in the target (so empty sections still appear). */
  private async ensureSectionFolders(ctx: RunContext): Promise<void> {
    const existing = await readdirSafe(ctx.targetRoot)
    const names = new Set(existing.map((e) => e.name))
    for (const section of this.deps.sectionsRepo.listByGroup(ctx.groupId)) {
      if (!section.folderName) continue
      const key = fold(section.folderName)
      const match = existing.find((e) => e.isDirectory() && fold(e.name) === key)
      if (match) {
        ctx.topFolders.set(key, ctx.topFolders.get(key) ?? match.name)
        continue
      }
      const known = ctx.topFolders.get(key)
      if (known) continue
      const name = uniqueName(names, section.folderName)
      await this.makeDir(ctx, [name])
      names.add(name)
      ctx.topFolders.set(key, name)
    }
  }

  /** Target descriptions win; source descriptions follow their files to their new names. */
  private async mergeMeta(ctx: RunContext): Promise<void> {
    const metaPath = this.deps.metaStore.metaPath(ctx.targetRoot)
    const sourceMeta = await this.deps.metaStore.read(ctx.sourceRoot)
    try {
      ctx.manifest.metaBackup = await readFile(metaPath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      ctx.manifest.metaBackup = null
      if (!(await isDirectory(dirname(metaPath)))) ctx.manifest.createdDirs.unshift(META_DIR)
    }
    await this.flush(ctx)
    await this.deps.metaStore.updateMeta(ctx.targetRoot, (meta) => {
      for (const [srcKey, value] of Object.entries(sourceMeta.items)) {
        const destKey = ctx.relMap.get(srcKey)
        if (destKey === undefined || destKey in meta.items) continue
        meta.items[destKey] = value
      }
      const seen = new Set(meta.sections.map((s) => fold(s.folder)))
      for (const section of sourceMeta.sections) {
        if (seen.has(fold(section.folder))) continue
        const folder = ctx.topFolders.get(fold(section.folder)) ?? section.folder
        meta.sections.push({ ...section, folder })
        seen.add(fold(folder))
      }
    })
  }

  /** Every copy exists with the right size, and no source file changed while we copied. */
  private async verify(ctx: RunContext): Promise<void> {
    if (ctx.copied.length !== ctx.total) {
      throw new Error(`verify failed: copied ${ctx.copied.length} of ${ctx.total} files`)
    }
    let done = 0
    for (const file of ctx.copied) {
      const [dest, src] = await Promise.all([this.fs.stat(file.dest), this.fs.stat(file.src)])
      if (dest.size !== file.size || src.size !== file.size || src.mtimeMs !== file.mtimeMs) {
        throw new Error(`verify failed: ${file.dest}`)
      }
      ctx.done = ++done
      if (done % PROGRESS_EVERY === 0 || done === ctx.total) this.progress(ctx, 'verifying', true)
    }
    ctx.done = ctx.total
  }

  private async emptyDirectory(dir: string): Promise<void> {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      try {
        await this.fs.rm(join(dir, entry.name), { recursive: true, force: true })
      } catch (error: unknown) {
        this.warn(`link: could not delete ${join(dir, entry.name)} after the switch`, error)
      }
    }
  }

  // ---- folder-only --------------------------------------------------------------------------------

  /**
   * Failure policy: the rename and the folder creation are undone (the kept folder is renamed
   * back, created folders removed) for any failure up to and including the flip.
   */
  private async runFolderOnly(groupId: string, source: string, target: string): Promise<void> {
    const kept = this.keptAsidePath(groupId)
    const ctx = this.newContext(groupId, source, target, 0)
    this.begin(groupId, {
      kind: 'link-folder-only',
      sourceRoot: source,
      targetRoot: target,
      manifestPath: ctx.manifestPath
    })
    let renamed = false
    try {
      this.progress(ctx, 'preparing', true)
      await this.flush(ctx)
      await moveDirectory(source, kept, this.fs)
      renamed = true
      await this.ensureSectionFolders(ctx)
      this.progress(ctx, 'switching', true)
      this.deps.storageRepo.flipStorage(groupId, {
        mode: 'linked',
        linkedPath: target,
        keptAside: true
      })
    } catch (error: unknown) {
      await this.rollBack(ctx, async () => {
        if (renamed) await moveDirectory(kept, source, this.fs)
      })
      throw asAppError(error)
    }
    await this.fs.rm(ctx.manifestPath, { force: true }).catch(() => undefined)
    this.syncFolderNames(groupId, ctx.topFolders)
    this.progress(ctx, 'done', true)
  }

  // ---- unlink / use app storage ------------------------------------------------------------------

  private requireLinked(groupId: string): KnowledgeStorageRow & { linkedPath: string } {
    const row = this.deps.storageRepo.get(groupId)
    if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    if (row.mode !== 'linked' || !row.linkedPath) throw new AppErrorException('STORAGE_NOT_LINKED')
    if (row.pendingOp !== null) throw new AppErrorException('STORAGE_OP_PENDING')
    return { ...row, linkedPath: row.linkedPath }
  }

  private dirs(groupId: string): GroupDirs {
    return groupDirs(this.deps.appDataDir, groupId)
  }

  /**
   * Unlinks the group. `keep-current` copies the linked folder's knowledge into app storage (staged
   * in `knowledge.tmp/`, verified, swapped in by rename); `restore-kept` renames the kept-aside
   * `knowledge.kept/` back to `knowledge/`. The linked folder is only ever read: no write, delete,
   * rename or `.arc/meta.json` update happens there (the copy reads `.arc/meta.json` as plain bytes
   * and never goes through MetaStore, whose legacy-folder migration would rename inside it).
   *
   * What happens to kept-aside knowledge on `keep-current`: it is discarded, because the user chose
   * the folder's contents over it and nothing would offer it back afterwards. It is moved to
   * `knowledge.discarded/` before the flip (undone by rollback) and deleted only after the flip
   * committed; a crash after the flip is cleaned up at startup.
   */
  async unlink(groupId: string, choice: StorageUnlinkChoice): Promise<StorageState> {
    await this.withLock(groupId, async () => {
      const row = this.requireLinked(groupId)
      if (choice === 'restore-kept') {
        if (!row.keptAside || !(await isDirectory(this.dirs(groupId).kept))) {
          throw new AppErrorException('STORAGE_NO_KEPT_ASIDE')
        }
        await this.withWatcherPaused(groupId, () => this.runRestoreKept(groupId))
      } else {
        // Copy-back needs the folder; restore-kept does not (it never reads the linked folder).
        if (!(await isAvailable(row.linkedPath)))
          throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
        await this.withWatcherPaused(groupId, () =>
          this.runCopyBack(groupId, row.linkedPath, row.keptAside)
        )
      }
    })
    return this.getState(groupId)
  }

  /**
   * The linked folder is missing and the user gave up on it. Kept-aside knowledge is restored the
   * same way as `unlink` + `restore-kept`; otherwise app storage starts with an empty knowledge
   * folder (one folder per known section), because the missing folder cannot be copied. The missing
   * path is never touched. Refused with STORAGE_ROOT_AVAILABLE when the folder came back, so a
   * stale button cannot hide a folder that is readable again.
   */
  async useAppStorage(groupId: string): Promise<StorageState> {
    await this.withLock(groupId, async () => {
      const row = this.requireLinked(groupId)
      if (await isAvailable(row.linkedPath)) throw new AppErrorException('STORAGE_ROOT_AVAILABLE')
      const dirs = this.dirs(groupId)
      if (row.keptAside && (await isDirectory(dirs.kept))) {
        await this.withWatcherPaused(groupId, () => this.runRestoreKept(groupId))
      } else {
        await this.withWatcherPaused(groupId, () => this.runEmptyAppStorage(groupId))
      }
    })
    return this.getState(groupId)
  }

  /** Pauses the watcher around `run` (which ends with the flip), then runs the shared after-flip steps. */
  private async withWatcherPaused(groupId: string, run: () => Promise<void>): Promise<void> {
    const wasWatching = this.deps.watcher.watchedGroupId === groupId
    if (wasWatching) this.deps.watcher.pause()
    let flipped = false
    try {
      await run()
      flipped = true
    } finally {
      if (!flipped && wasWatching) await this.deps.watcher.resume().catch(() => undefined)
    }
    await this.afterFlip(groupId, wasWatching)
  }

  /** Files and folders to copy back: everything except hidden entries, plus `.arc/meta.json`. */
  private async planCopyBack(
    linkedRoot: string
  ): Promise<{ dirs: string[][]; files: { rel: string[]; dest: string[] }[] }> {
    const dirs: string[][] = []
    const files: { rel: string[]; dest: string[] }[] = []
    async function walk(rel: string[]): Promise<void> {
      const entries = (await readdir(join(linkedRoot, ...rel), { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name)
      )
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory()) {
          dirs.push([...rel, entry.name])
          await walk([...rel, entry.name])
        } else if (entry.isFile())
          files.push({ rel: [...rel, entry.name], dest: [...rel, entry.name] })
      }
    }
    await walk([])
    for (const legacy of [META_DIR, '.harness']) {
      const meta = await lstat(join(linkedRoot, legacy, 'meta.json')).catch(() => null)
      if (meta?.isFile()) {
        files.push({ rel: [legacy, 'meta.json'], dest: [META_DIR, 'meta.json'] })
        break
      }
    }
    return { dirs, files }
  }

  /**
   * Failure policy. Anything that fails before the flip (copy, verify, the swap, the flip itself)
   * is rolled back: staging and the stale `knowledge/` are removed, kept-aside knowledge is moved
   * back, the marker is cleared and the group stays linked. After the flip only the discard of
   * kept-aside knowledge is left, and a failure there is logged (startup recovery retries it).
   */
  private async runCopyBack(
    groupId: string,
    linkedRoot: string,
    keptAside: boolean
  ): Promise<void> {
    const dirs = this.dirs(groupId)
    const ctx = this.newContext(groupId, linkedRoot, dirs.tmp, 0)
    this.begin(groupId, {
      kind: 'unlink-copy-back',
      sourceRoot: linkedRoot,
      targetRoot: dirs.tmp,
      manifestPath: ctx.manifestPath
    })
    try {
      this.progress(ctx, 'preparing', true)
      await this.flush(ctx)
      // A previous crashed run (or a failed rollback) may have left staging behind: never merge with it.
      await this.fs.rm(dirs.tmp, { recursive: true, force: true })
      const plan = await this.planCopyBack(linkedRoot)
      ctx.total = plan.files.length
      await this.fs.mkdir(dirs.tmp, { recursive: true })
      for (const dir of plan.dirs) await this.fs.mkdir(join(dirs.tmp, ...dir), { recursive: true })
      for (const file of plan.files) {
        const src = join(linkedRoot, ...file.rel)
        const dest = join(dirs.tmp, ...file.dest)
        const info = await lstat(src)
        await this.fs.mkdir(dirname(dest), { recursive: true })
        await this.fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL)
        ctx.copied.push({ src, dest, size: info.size, mtimeMs: info.mtimeMs })
        ctx.done++
        this.progress(ctx, 'copying')
      }
      await this.verify(ctx)
      this.progress(ctx, 'switching', true)
      // `knowledge/` is a stale leftover in linked mode (for example a link whose source delete failed).
      await this.fs.rm(dirs.app, { recursive: true, force: true })
      const discard = keptAside && (await isDirectory(dirs.kept))
      if (discard) await moveDirectory(dirs.kept, dirs.discarded, this.fs)
      await moveDirectory(dirs.tmp, dirs.app, this.fs)
      this.deps.storageRepo.flipStorage(groupId, { mode: 'app', keptAside: false })
    } catch (error: unknown) {
      await this.rollBack(ctx, async () => {
        this.deps.log?.info?.(
          `unlink copy-back rolled back: ${await undoStorageDirs('unlink-copy-back', dirs, { mode: 'linked', keptAside }, this.fs)}`
        )
      })
      throw asAppError(error)
    }
    this.progress(ctx, 'cleaning', true)
    await this.fs.rm(dirs.discarded, { recursive: true, force: true }).catch((error: unknown) => {
      this.warn('unlink: could not delete the discarded kept-aside knowledge', error)
    })
    await this.fs.rm(ctx.manifestPath, { force: true }).catch(() => undefined)
    this.progress(ctx, 'done', true)
  }

  /** Renames `knowledge.kept/` back to `knowledge/`. Failure before the flip renames it back. */
  private async runRestoreKept(groupId: string): Promise<void> {
    const dirs = this.dirs(groupId)
    const ctx = this.newContext(groupId, dirs.kept, dirs.app, 0)
    this.begin(groupId, {
      kind: 'unlink-restore',
      sourceRoot: dirs.kept,
      targetRoot: dirs.app,
      manifestPath: ctx.manifestPath
    })
    try {
      this.progress(ctx, 'preparing', true)
      await this.flush(ctx)
      await this.fs.rm(dirs.app, { recursive: true, force: true }) // stale leftover
      await moveDirectory(dirs.kept, dirs.app, this.fs)
      this.progress(ctx, 'switching', true)
      this.deps.storageRepo.flipStorage(groupId, { mode: 'app', keptAside: false })
    } catch (error: unknown) {
      await this.rollBack(ctx, async () => {
        this.deps.log?.info?.(
          `unlink restore rolled back: ${await undoStorageDirs('unlink-restore', dirs, { mode: 'linked', keptAside: true }, this.fs)}`
        )
      })
      throw asAppError(error)
    }
    await this.restoreSections(groupId, dirs.app)
    await this.fs.rm(ctx.manifestPath, { force: true }).catch(() => undefined)
    this.progress(ctx, 'done', true)
  }

  /**
   * The registry is shared across storage modes, so sections adopted from the linked folder are
   * still in it after the kept-aside knowledge is back. Keeps a custom section only when the
   * restored knowledge has its folder and its meta.json lists it (when meta.json lists none, the
   * folder alone decides), and takes the names back from meta.json. Folders the restored root has
   * but the registry lost are re-adopted by the after-flip step. Never throws.
   */
  private async restoreSections(groupId: string, root: string): Promise<void> {
    try {
      const meta = await this.deps.metaStore.read(root)
      const listed = new Map(meta.sections.map((s) => [fold(s.folder), s.name]))
      const folders = new Set(
        (await readdirSafe(root)).filter((e) => e.isDirectory()).map((e) => fold(e.name))
      )
      for (const section of this.deps.sectionsRepo.listByGroup(groupId)) {
        if (section.kind !== 'custom' || !section.folderName) continue
        const key = fold(section.folderName)
        if (!folders.has(key) || (listed.size > 0 && !listed.has(key))) {
          this.deps.sectionsRepo.delete(section.id)
          continue
        }
        const name = listed.get(key)
        if (name && name !== section.name) {
          try {
            this.deps.sectionsRepo.update(section.id, {
              name,
              nameKey: sectionNameKey(name),
              folderName: section.folderName
            })
          } catch {
            // name taken by another section: keep the current one
          }
        }
      }
    } catch (error: unknown) {
      this.warn('unlink: could not restore the sections registry', error)
    }
  }

  /**
   * No pending marker: every step is either harmless to repeat or the single database flip. A
   * crash before the flip leaves an unused app folder in a group that is still linked.
   */
  private async runEmptyAppStorage(groupId: string): Promise<void> {
    const dirs = this.dirs(groupId)
    await this.fs.rm(dirs.app, { recursive: true, force: true })
    await this.fs.mkdir(dirs.app, { recursive: true })
    for (const section of this.deps.sectionsRepo.listByGroup(groupId)) {
      if (section.folderName) {
        await this.fs.mkdir(join(dirs.app, section.folderName), { recursive: true })
      }
    }
    this.deps.storageRepo.flipStorage(groupId, { mode: 'app', keptAside: false })
  }

  // ---- locate ---------------------------------------------------------------------------------------

  /**
   * Opens the folder picker and relinks the group to the chosen folder (same preflight as link, so
   * nesting and writability are enforced; a rejected folder throws the matching STORAGE_TARGET_*
   * code). Nothing is copied or deleted: only `linked_path` changes, kept-aside knowledge stays
   * kept aside, and the index is reconciled against the new folder.
   *
   * Sanity check: advisory only (`looksLikeKnowledge`). A user may point at a fresh clone, a renamed
   * folder or a folder they are about to fill, so a folder without `.arc/meta.json` is still
   * accepted; the UI can warn. Nothing on disk is lost either way.
   */
  async locate(groupId: string): Promise<StorageLocateResult> {
    this.requireLinked(groupId)
    const chosen = await this.deps.dialogs.pickFolders({ multi: false })
    const first = chosen?.[0]
    if (!first) return { located: false }
    let looksLikeKnowledge = false
    await this.withLock(groupId, async () => {
      const row = this.requireLinked(groupId)
      const pre = await this.preflight(groupId, first)
      if (pre.blocked) throw new AppErrorException(blockedToCode(pre.blocked))
      looksLikeKnowledge = await this.looksLikeKnowledge(groupId, pre.path)
      await this.switchRoot(groupId, () =>
        this.deps.storageRepo.flipStorage(groupId, {
          mode: 'linked',
          linkedPath: pre.path,
          keptAside: row.keptAside
        })
      )
    })
    return { located: true, state: await this.getState(groupId), looksLikeKnowledge }
  }

  private async switchRoot(groupId: string, flip: () => void): Promise<void> {
    await this.withWatcherPaused(groupId, () => {
      flip()
      return Promise.resolve()
    })
  }

  private async looksLikeKnowledge(groupId: string, path: string): Promise<boolean> {
    if (
      await lstat(this.deps.metaStore.metaPath(path)).then(
        (i) => i.isFile(),
        () => false
      )
    ) {
      return true
    }
    const names = new Set(
      (await readdirSafe(path)).filter((e) => e.isDirectory()).map((e) => fold(e.name))
    )
    return this.deps.sectionsRepo
      .listByGroup(groupId)
      .some((section) => section.folderName !== null && names.has(fold(section.folderName)))
  }

  // ---- shared finishing ---------------------------------------------------------------------------------

  /** Registry folder names follow the actual (case-folded equal) folder names found in the target. */
  private syncFolderNames(groupId: string, topFolders: Map<string, string>): void {
    try {
      for (const section of this.deps.sectionsRepo.listByGroup(groupId)) {
        const actual = section.folderName ? topFolders.get(fold(section.folderName)) : undefined
        if (actual && actual !== section.folderName) {
          this.deps.sectionsRepo.update(section.id, {
            name: section.name,
            nameKey: section.nameKey,
            folderName: actual
          })
        }
      }
    } catch (error: unknown) {
      this.warn('link: could not sync section folder names', error)
    }
  }

  /** Index reconcile for the new root, watcher restart on it, then `knowledge:changed`. Never throws. */
  private async afterFlip(groupId: string, wasWatching: boolean): Promise<void> {
    try {
      await this.deps.adoptFolders(groupId)
      await this.deps.index.reconcileGroup(groupId)
    } catch (error: unknown) {
      this.warn('link: reconcile after switch failed', error)
    }
    if (wasWatching) {
      try {
        await this.deps.watcher.start(groupId)
        await this.deps.watcher.resume()
      } catch (error: unknown) {
        this.warn('link: could not restart the watcher', error)
      }
    }
    this.deps.emit('knowledge:changed', {
      groupId,
      sectionIds: this.deps.sectionsRepo
        .listByGroup(groupId)
        .filter((s) => s.folderName !== null)
        .map((s) => s.id),
      sectionsChanged: true,
      reason: 'storage'
    })
  }
}

function blockedToCode(reason: StorageBlockedReason): ErrorCode {
  switch (reason) {
    case 'not-a-folder':
      return 'STORAGE_TARGET_INVALID'
    case 'not-writable':
      return 'STORAGE_TARGET_NOT_WRITABLE'
    case 'inside-app-storage':
    case 'contains-app-storage':
    case 'inside-other-group':
    case 'contains-other-group':
      return 'STORAGE_TARGET_NESTED'
  }
}

function asAppError(error: unknown): AppErrorException {
  return error instanceof AppErrorException ? error : new AppErrorException('IO_FAILED')
}
