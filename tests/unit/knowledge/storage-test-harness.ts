import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeStorageRepo } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { ProjectsRepo } from '../../../src/main/db/repositories/projects-repo'
import { KnowledgeStorageService } from '../../../src/main/knowledge/knowledge-storage-service'
import type {
  FsOps,
  KnowledgeStorageServiceDeps
} from '../../../src/main/knowledge/knowledge-storage-service'
import type { IpcEvents } from '../../../src/shared/ipc/contract'
import { createEnv } from './knowledge-test-env'
import type { KnowledgeEnv } from './knowledge-test-env'

type Progress = IpcEvents['storage:progress']
type Changed = IpcEvents['knowledge:changed']

export interface StorageHarness {
  env: KnowledgeEnv
  service: KnowledgeStorageService
  storageRepo: KnowledgeStorageRepo
  userData: string
  target: string
  progress: Progress[]
  changed: Changed[]
  watcher: { calls: string[]; watchedGroupId: string | null }
  picks: (string[] | null)[]
  warn: Mock<(...args: unknown[]) => void>
  groupDir: string
}

export interface SetupOptions {
  fs?: Partial<FsOps>
  storageRepoWrap?: (repo: KnowledgeStorageRepo) => KnowledgeStorageServiceDeps['storageRepo']
}

/** Builds a service over an existing environment; a second call models an app restart. */
export function buildService(
  env: KnowledgeEnv,
  dir: string,
  options: SetupOptions = {}
): StorageHarness {
  const userData = join(dir, 'userData')
  const target = join(dir, 'ext', 'target')
  const storageRepo = new KnowledgeStorageRepo(env.opened.db)
  const progress: Progress[] = []
  const changed: Changed[] = []
  const picks: (string[] | null)[] = []
  const calls: string[] = []
  const watcher = {
    calls,
    watchedGroupId: env.groupId as string | null,
    pause: () => calls.push('pause'),
    resume: () => {
      calls.push('resume')
      return Promise.resolve()
    },
    start: (id: string) => {
      calls.push(`start:${id}`)
      return Promise.resolve()
    }
  }
  const warn = vi.fn<(...args: unknown[]) => void>()
  const service = new KnowledgeStorageService({
    storageRepo: options.storageRepoWrap ? options.storageRepoWrap(storageRepo) : storageRepo,
    projectsRepo: new ProjectsRepo(env.opened.db),
    sectionsRepo: env.sectionsRepo,
    metaStore: env.metaStore,
    dialogs: { pickFolders: () => Promise.resolve(picks.shift() ?? null) },
    groupsRepo: new GroupsRepo(env.opened.db),
    watcher,
    index: env.index,
    adoptFolders: (id) => env.sections.adoptFolders(id),
    listGroupIds: () => new GroupsRepo(env.opened.db).list().map((g) => g.id),
    appDataDir: userData,
    emit: ((event: string, payload: unknown) => {
      if (event === 'storage:progress') progress.push(payload as Progress)
      else changed.push(payload as Changed)
    }) as KnowledgeStorageServiceDeps['emit'],
    log: { warn, info: () => undefined, error: () => undefined },
    ...(options.fs ? { fs: options.fs } : {})
  })
  return {
    env,
    service,
    storageRepo,
    userData,
    target,
    progress,
    changed,
    watcher,
    picks,
    warn,
    groupDir: join(userData, 'groups', env.groupId)
  }
}

export async function setup(dir: string, options: SetupOptions = {}): Promise<StorageHarness> {
  const env = await createEnv(dir)
  await mkdir(join(dir, 'ext', 'target'), { recursive: true })
  return buildService(env, dir, options)
}

export async function put(root: string, rel: string, text: string): Promise<void> {
  const path = join(root, ...rel.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text)
}

/** relative path -> text for every file below root (dot entries included). */
export async function tree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name), `${prefix}${e.name}/`)
      else out[`${prefix}${e.name}`] = await readFile(join(dir, e.name), 'utf8')
    }
  }
  await walk(root, '')
  return out
}

/** A fingerprint of everything observable in a tree: names, kinds, sizes, mtimes and content. */
export async function fingerprint(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const abs = join(dir, e.name)
      const info = await stat(abs)
      if (e.isDirectory()) {
        out.push(`d ${prefix}${e.name} ${info.mtimeMs}`)
        await walk(abs, `${prefix}${e.name}/`)
      } else {
        out.push(`f ${prefix}${e.name} ${info.size} ${info.mtimeMs} ${await readFile(abs, 'utf8')}`)
      }
    }
  }
  await walk(root, '')
  return out
}

export async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

export function titles(h: StorageHarness, sectionId: string): string[] {
  return h.env.itemsRepo
    .listBySection(sectionId)
    .map((r) => r.title)
    .sort()
}

export interface CrashFs {
  fs: Partial<FsOps>
  /** Every call that reached the real filesystem, as `op:path`. */
  log: string[]
  /** Makes every later fs call fail, like a process that is gone. */
  kill(): void
}

/**
 * Fails like a crash: the `nth` call (1-based) of `op` and everything after it rejects, so the
 * service's own rollback cannot run either and the disk stays exactly as it was at that point.
 */
export function crashFs(
  op: keyof FsOps | null,
  nth: number,
  when?: (path: string) => boolean
): CrashFs {
  let dead = false
  let seen = 0
  const log: string[] = []
  function guard<A extends [string, ...unknown[]], R>(
    name: keyof FsOps,
    fn: (...args: A) => Promise<R>
  ): (...args: A) => Promise<R> {
    return (...args: A) => {
      if (!dead && name === op && (when?.(String(args[0])) ?? true) && ++seen === nth) dead = true
      if (dead) return Promise.reject(new Error(`simulated crash at ${name} ${String(args[0])}`))
      log.push(`${name}:${String(args[0])}`)
      return fn(...args)
    }
  }
  return {
    log,
    kill: () => {
      dead = true
    },
    fs: {
      copyFile: guard('copyFile', (s: string, d: string, m?: number) => copyFile(s, d, m)),
      rename: guard('rename', (a: string, b: string) => rename(a, b)),
      rm: guard('rm', (p: string, o: { recursive?: boolean; force?: boolean }) => rm(p, o)),
      rmdir: guard('rmdir', (p: string) => rmdir(p)),
      mkdir: guard('mkdir', async (p: string, o?: { recursive?: boolean }) => {
        await mkdir(p, o)
      })
    }
  }
}
