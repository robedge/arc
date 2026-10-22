import { readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { watch as chokidarWatch } from 'chokidar'
import type { IpcEvents, KnowledgeChangedItem } from '@shared/ipc/contract'
import type { Section } from '@shared/types/section'
import type { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { SectionsRepo } from '../db/repositories/sections-repo'
import { onAtomicWrite } from './atomic-write'
import type { AtomicWriteInfo } from './atomic-write'
import { revisionOfRow } from './knowledge-index'
import type { KnowledgeIndex } from './knowledge-index'
import { MAX_SECTION_DEPTH, MAX_SECTION_FILES, isNonKnowledgeFolder } from './section-scan'

export const WATCH_DEBOUNCE_MS = 300
export const ECHO_TTL_MS = 3000
export const WATCH_FILE_CAP = MAX_SECTION_FILES
/** Re-check interval for folders above the file cap, where live watching is off. */
export const POLL_INTERVAL_MS = 5000
/** Above this many changed items the payload omits `items` and the renderer re-lists sections. */
export const MAX_ITEMS_IN_PAYLOAD = 500
/** root/<section>/<MAX_SECTION_DEPTH subfolders>/<file>. */
const WATCH_DEPTH = MAX_SECTION_DEPTH + 2
const META_DIR = '.arc'

type ChangedPayload = IpcEvents['knowledge:changed']

/** The slice of chokidar's FSWatcher this module uses (lets tests inject a fake). */
export interface WatcherHandle {
  on(event: 'all', listener: (event: string, path: string) => void): WatcherHandle
  on(event: 'error', listener: (error: unknown) => void): WatcherHandle
  on(event: 'ready', listener: () => void): WatcherHandle
  close(): Promise<void>
}

export type WatchFactory = (root: string, ignored: (path: string) => boolean) => WatcherHandle

export interface KnowledgeWatcherDeps {
  getKnowledgeRoot: (groupId: string) => string
  index: Pick<KnowledgeIndex, 'reconcileSection' | 'reconcileGroup'>
  sectionsRepo: Pick<SectionsRepo, 'listByGroup'>
  itemsRepo: Pick<KnowledgeItemsRepo, 'listBySection'>
  /** Adopts new subfolders as custom sections; returns the new sections. */
  adoptFolders: (groupId: string) => Promise<Section[]>
  emit: (event: 'knowledge:changed', payload: ChangedPayload) => void
  log?: { warn: (...args: unknown[]) => void; info?: (...args: unknown[]) => void }
  watch?: WatchFactory
  /**
   * Called (at most once per watch) when the watched root itself was removed or renamed away, so
   * the availability service can re-check it now instead of at its next tick.
   */
  onRootGone?: (groupId: string) => void
  /** Subscribes to the app's own atomic writes; defaults to `onAtomicWrite`. */
  subscribeWrites?: (hook: (path: string, info: AtomicWriteInfo) => void) => () => void
  statFile?: (path: string) => Promise<AtomicWriteInfo | null>
  countFiles?: (root: string, cap: number) => Promise<number>
  now?: () => number
  debounceMs?: number
  echoTtlMs?: number
  fileCap?: number
  pollMs?: number
}

/** folder name -> signature of the files below it (names, mtimes, sizes; never contents). */
type DirSnapshot = Map<string, string>

/**
 * Snapshots the top-level folders of `root` (plus `.arc`): every file down to the section depth
 * is listed, which is all the index reads. Uses readdir and stat only, so big files are never
 * opened.
 */
export async function snapshotFolders(root: string): Promise<DirSnapshot> {
  const snapshot: DirSnapshot = new Map()
  let tops
  try {
    tops = await readdir(root, { withFileTypes: true })
  } catch {
    return snapshot
  }
  for (const top of tops) {
    if (!top.isDirectory() || isIgnoredRelPath(top.name)) continue
    const parts: string[] = []
    const walk = async (rel: string, depth: number): Promise<void> => {
      let names
      try {
        names = await readdir(join(root, rel), { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of names.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
        const entryRel = join(rel, entry.name)
        if (isIgnoredRelPath(entryRel)) continue
        if (entry.isDirectory()) {
          if (depth < MAX_SECTION_DEPTH) await walk(entryRel, depth + 1)
          continue
        }
        try {
          const info = await stat(join(root, entryRel))
          parts.push(`${entryRel}|${info.mtimeMs}|${info.size}`)
        } catch {
          // vanished between readdir and stat
        }
      }
    }
    await walk(top.name, 0)
    snapshot.set(top.name, parts.join('\n'))
  }
  return snapshot
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/** True for paths the watcher must not react to; `rel` is relative to the knowledge root. */
export function isIgnoredRelPath(rel: string): boolean {
  if (rel === '') return false
  const segments = rel.split(sep)
  for (const [index, segment] of segments.entries()) {
    if (segment.startsWith('.') && segment !== META_DIR) return true
    // Below a section folder, dependency and build output is never indexed, so never watched.
    if (index > 0 && isNonKnowledgeFolder(segment)) return true
  }
  const name = segments[segments.length - 1] ?? ''
  return (
    name === '.DS_Store' ||
    name.endsWith('~') ||
    name.endsWith('.tmp') ||
    name.endsWith('.swp') ||
    name.endsWith('.crdownload')
  )
}

/**
 * Remembers the app's own recent writes (path + mtime + size) so the watcher events they cause
 * can be dropped. An entry matches only while the file still has the recorded mtime and size, so
 * a later outside edit is never mistaken for an echo. Entries expire after `ttlMs`.
 */
export class EchoSuppressor {
  private readonly entries = new Map<string, { info: AtomicWriteInfo; expiresAt: number }>()

  constructor(
    private readonly ttlMs: number = ECHO_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  record(path: string, info: AtomicWriteInfo): void {
    this.entries.set(path, { info, expiresAt: this.now() + this.ttlMs })
  }

  /** True when `current` (the file's stat now, null when missing) is the recorded own write. */
  isEcho(path: string, current: AtomicWriteInfo | null): boolean {
    const entry = this.entries.get(path)
    if (!entry) return false
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(path)
      return false
    }
    return (
      current !== null && current.mtimeMs === entry.info.mtimeMs && current.size === entry.info.size
    )
  }

  clear(): void {
    this.entries.clear()
  }
}

async function defaultStat(path: string): Promise<AtomicWriteInfo | null> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

/** Counts non-ignored files down to the watch depth, stopping once `cap` is exceeded. */
export async function countWatchedFiles(root: string, cap: number): Promise<number> {
  let count = 0
  async function walk(dir: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (count > cap) return
      const abs = join(dir, entry.name)
      if (isIgnoredRelPath(relative(root, abs))) continue
      if (entry.isDirectory()) {
        if (depth < WATCH_DEPTH) await walk(abs, depth + 1)
      } else {
        count++
      }
    }
  }
  await walk(root, 0)
  return count
}

function defaultWatch(root: string, ignored: (path: string) => boolean): WatcherHandle {
  return chokidarWatch(root, {
    ignoreInitial: true,
    depth: WATCH_DEPTH,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    ignored: (path) => ignored(path)
  })
}

/**
 * Watches the open group's knowledge root for outside changes. Events are coalesced over
 * `debounceMs`, own writes are dropped, the index is reconciled for the affected sections, and
 * `knowledge:changed` is emitted. Only one root is watched at a time (the open group).
 */
export class KnowledgeWatcher {
  private readonly watchFn: WatchFactory
  private readonly echo: EchoSuppressor
  private readonly statFile: (path: string) => Promise<AtomicWriteInfo | null>
  private readonly countFiles: (root: string, cap: number) => Promise<number>
  private readonly debounceMs: number
  private readonly fileCap: number
  private readonly pollMs: number
  private readonly unsubscribeWrites: () => void
  private current: { groupId: string; root: string; handle: WatcherHandle | null } | null = null
  private generation = 0
  private paused = false
  private rootGoneReported = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: KnowledgeWatcherDeps) {
    this.watchFn = deps.watch ?? defaultWatch
    this.statFile = deps.statFile ?? defaultStat
    this.countFiles = deps.countFiles ?? countWatchedFiles
    this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS
    this.fileCap = deps.fileCap ?? WATCH_FILE_CAP
    this.pollMs = deps.pollMs ?? POLL_INTERVAL_MS
    this.echo = new EchoSuppressor(deps.echoTtlMs ?? ECHO_TTL_MS, deps.now ?? Date.now)
    this.unsubscribeWrites = (deps.subscribeWrites ?? onAtomicWrite)((path, info) =>
      this.echo.record(path, info)
    )
  }

  get watchedGroupId(): string | null {
    return this.current?.groupId ?? null
  }

  /** Starts watching a group's root, replacing any previous watch. Never throws. */
  async start(groupId: string): Promise<void> {
    await this.stop()
    const generation = ++this.generation
    this.rootGoneReported = false
    let root: string
    try {
      root = this.deps.getKnowledgeRoot(groupId)
    } catch (error: unknown) {
      this.deps.log?.warn('watcher: no knowledge root', groupId, error)
      return
    }
    this.current = { groupId, root, handle: null }
    if ((await this.statFile(root)) === null) {
      this.deps.log?.warn(`watcher: knowledge root missing: ${root}`)
      return
    }
    if (generation !== this.generation) return
    const count = await this.countFiles(root, this.fileCap)
    if (generation !== this.generation) return
    if (count > this.fileCap) {
      // Too big for live watching: fall back to a cheap periodic directory-snapshot check.
      this.deps.log?.warn(
        `watcher: ${root} has more than ${this.fileCap} files; live watching disabled, polling instead`
      )
      const baseline = await snapshotFolders(root)
      if (generation !== this.generation) return
      this.schedulePoll(generation, root, groupId, baseline)
      return
    }
    const handle = this.watchFn(root, (path) => isIgnoredRelPath(relative(root, path)))
    handle.on('all', (event, path) => {
      if (event === 'unlinkDir' && path === root) void this.checkRootGone(generation)
      this.onEvent(generation, path)
    })
    handle.on('error', (error) => {
      this.deps.log?.warn('watcher error', error)
      void this.checkRootGone(generation)
    })
    // Chokidar starts scanning asynchronously and ignores the initial state; whatever changed
    // between our start and its ready event would otherwise be missed.
    handle.on('ready', () => {
      if (generation === this.generation) void this.rescan()
    })
    this.current.handle = handle
  }

  /** Stops watching and drops queued events. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.generation++
    this.clearTimer()
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    this.pending.clear()
    const handle = this.current?.handle
    this.current = null
    if (handle) await handle.close().catch(() => undefined)
  }

  private schedulePoll(
    generation: number,
    root: string,
    groupId: string,
    previous: DirSnapshot
  ): void {
    // A chained timeout (not an interval) so a slow poll never overlaps the next one.
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll(generation, root, groupId, previous)
    }, this.pollMs)
    this.pollTimer.unref()
  }

  private async poll(
    generation: number,
    root: string,
    groupId: string,
    previous: DirSnapshot
  ): Promise<void> {
    let next = previous
    try {
      if (generation !== this.generation) return
      if (!this.paused) {
        const current = await snapshotFolders(root)
        if (generation !== this.generation) return
        const changed: string[] = []
        for (const key of new Set([...previous.keys(), ...current.keys()])) {
          if (previous.get(key) !== current.get(key)) changed.push(key)
        }
        next = current
        if (changed.length > 0) {
          await this.enqueue(() => this.reconcile(generation, groupId, changed))
        }
      }
    } catch (error: unknown) {
      this.deps.log?.warn('watcher: poll failed', error)
    }
    if (generation === this.generation) this.schedulePoll(generation, root, groupId, next)
  }

  /** Stops only when `groupId` is the watched group (e.g. it was deleted). */
  async stopFor(groupId: string): Promise<void> {
    if (this.current?.groupId === groupId) await this.stop()
  }

  /** Stops and unsubscribes from own-write notifications. For app quit. */
  async dispose(): Promise<void> {
    this.unsubscribeWrites()
    this.echo.clear()
    await this.stop()
  }

  /** Resolves once every queued reconcile has finished (tests and orderly shutdown). */
  idle(): Promise<void> {
    return this.queue
  }

  /** Bulk operations (link, move, export) pause the watcher; events during the pause are dropped. */
  pause(): void {
    this.paused = true
    this.clearTimer()
    this.pending.clear()
  }

  /** Resumes after a bulk operation and rescans, since events were dropped meanwhile. */
  async resume(): Promise<void> {
    this.paused = false
    await this.rescan()
  }

  /** Full reconcile of the watched group (window focus, resume). Emits only if something changed. */
  rescan(): Promise<void> {
    const generation = this.generation
    const target = this.current
    if (!target || this.paused) return Promise.resolve()
    return this.enqueue(() => this.reconcile(generation, target.groupId, null))
  }

  /** Cheap stat of the root; reports it gone to `onRootGone` once per watch. */
  private async checkRootGone(generation: number): Promise<void> {
    const target = this.current
    if (generation !== this.generation || !target || this.rootGoneReported) return
    if ((await this.statFile(target.root)) !== null) return
    if (generation !== this.generation || this.rootGoneReported) return
    this.rootGoneReported = true
    try {
      this.deps.onRootGone?.(target.groupId)
    } catch (error: unknown) {
      this.deps.log?.warn('watcher: onRootGone failed', error)
    }
  }

  private onEvent(generation: number, absPath: string): void {
    if (generation !== this.generation || this.paused || !this.current) return
    this.pending.add(absPath)
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush(generation)
    }, this.debounceMs)
    this.timer.unref()
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private flush(generation: number): Promise<void> {
    const paths = [...this.pending]
    this.pending.clear()
    return this.enqueue(async () => {
      const target = this.current
      if (generation !== this.generation || this.paused || !target) return
      await this.checkRootGone(generation)
      if (generation !== this.generation) return
      const real: string[] = []
      for (const path of paths) {
        const info = await this.statFile(path)
        if (!this.echo.isEcho(path, info)) real.push(path)
      }
      if (real.length === 0) return
      await this.reconcile(
        generation,
        target.groupId,
        real.map((p) => relative(target.root, p))
      )
    })
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task)
    this.queue = run.catch((error: unknown) => {
      this.deps.log?.warn('watcher: reconcile failed', error)
    })
    return this.queue
  }

  /** `relPaths` null = every section. */
  private async reconcile(
    generation: number,
    groupId: string,
    relPaths: string[] | null
  ): Promise<void> {
    const { sectionsRepo, itemsRepo, index } = this.deps
    let sectionsChanged = false
    const adoptedIds: string[] = []
    const knownFolders = new Set(
      sectionsRepo
        .listByGroup(groupId)
        .map((s) => s.folderName)
        .filter((f): f is string => f !== null)
        .map(fold)
    )
    const tops = relPaths?.map((p) => p.split(sep)[0] ?? '') ?? []
    const touchesUnknownFolder = tops.some(
      (t) => t !== '' && t !== META_DIR && !knownFolders.has(fold(t))
    )
    if (relPaths === null || touchesUnknownFolder) {
      const adopted = await this.deps.adoptFolders(groupId)
      if (adopted.length > 0) {
        sectionsChanged = true
        adoptedIds.push(...adopted.map((s) => s.id))
      }
    }
    if (generation !== this.generation) return

    const allSections = sectionsRepo.listByGroup(groupId).filter((s) => s.folderName !== null)
    const wholeGroup = relPaths === null || tops.includes(META_DIR)
    const touched = new Set(tops.map(fold))
    const affected = allSections.filter((s) => wholeGroup || touched.has(fold(s.folderName ?? '')))

    const changedItems: KnowledgeChangedItem[] = []
    const sectionIds = new Set<string>(adoptedIds)
    for (const section of affected) {
      const snapshot = (): Map<string, { key: string; revision: string }> =>
        new Map(
          itemsRepo.listBySection(section.id).map((r) => {
            const revision = revisionOfRow(r)
            // Descriptions live in meta.json, so they can change without the revision changing.
            return [r.id, { key: `${revision}|${r.title}|${r.description ?? ''}`, revision }]
          })
        )
      const before = snapshot()
      await index.reconcileSection(groupId, section.id)
      if (generation !== this.generation) return
      const after = snapshot()
      let changed = false
      for (const [id, now] of after) {
        if (before.get(id)?.key !== now.key) {
          changedItems.push({ id, sectionId: section.id, revision: now.revision })
          changed = true
        }
      }
      for (const id of before.keys()) {
        if (!after.has(id)) {
          changedItems.push({ id, sectionId: section.id, revision: null })
          changed = true
        }
      }
      if (changed) sectionIds.add(section.id)
    }
    if (sectionIds.size === 0 && !sectionsChanged) return
    this.deps.emit('knowledge:changed', {
      groupId,
      sectionIds: [...sectionIds],
      ...(sectionsChanged ? { sectionsChanged: true } : {}),
      ...(changedItems.length <= MAX_ITEMS_IN_PAYLOAD ? { items: changedItems } : {}),
      reason: 'external'
    })
  }
}
