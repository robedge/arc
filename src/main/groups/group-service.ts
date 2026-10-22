import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AppErrorException } from '@shared/errors'
import { groupNameKey, normalizeGroupName } from '@shared/group-name'
import { GROUP_NAME_MAX } from '@shared/limits'
import { BUILT_IN_SECTIONS, sectionNameKey } from '@shared/sections'
import type { Group } from '@shared/types/group'
import { ulid } from '../db/ids'
import type { Db } from '../db/client'
import { KnowledgeStorageRepo } from '../db/repositories/knowledge-storage-repo'
import { ProjectsRepo } from '../db/repositories/projects-repo'
import { SectionsRepo } from '../db/repositories/sections-repo'
import { GroupsRepo, isUniqueViolation } from '../db/repositories/groups-repo'
import type { GroupRow } from '../db/repositories/groups-repo'

export interface GroupServiceDeps {
  /** Used to seed a new group's sections and storage row in one transaction. */
  db: Db
  groupsRepo: GroupsRepo
  /** Electron userData directory; groups live under `<appDataDir>/groups/<id>/`. */
  appDataDir: string
  /** Exports the group's knowledge using a picked-folder token; must throw if it fails. */
  exportKnowledge?: (groupId: string, token: string) => Promise<unknown>
  /** Runs `task` as the only storage operation for the group (STORAGE_BUSY otherwise). */
  withStorageLock?: <T>(groupId: string, task: () => Promise<T>) => Promise<T>
  /** Stops watching the group's knowledge folder before anything is removed. */
  stopWatcher?: (groupId: string) => Promise<void>
  /** Stops the group's session processes and removes their folders before the rows cascade away. */
  removeSessions?: (groupId: string) => Promise<void>
  now?: () => number
  newId?: () => string
}

const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * Removes `<appDataDir>/groups/<groupId>/` recursively. Refuses (throws, deletes nothing)
 * unless the id is ULID-shaped and the resolved target equals that exact path.
 * A missing folder is not an error. Only ever touches the app-managed directory.
 */
export async function removeAppGroupDir(appDataDir: string, groupId: string): Promise<void> {
  const expected = resolve(appDataDir, 'groups', groupId)
  const target = resolve(join(appDataDir, 'groups', groupId))
  if (
    !ULID_SHAPE.test(groupId) ||
    target !== expected ||
    target === resolve(appDataDir, 'groups')
  ) {
    throw new AppErrorException('PATH_OUTSIDE_ROOT')
  }
  await rm(target, { recursive: true, force: true })
}

function toGroup(row: GroupRow): Group {
  return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt }
}

export class GroupService {
  private readonly db: Db
  private readonly repo: GroupsRepo
  private readonly appDataDir: string
  private readonly exportKnowledge?: GroupServiceDeps['exportKnowledge']
  private readonly withStorageLock: NonNullable<GroupServiceDeps['withStorageLock']>
  private readonly stopWatcher?: GroupServiceDeps['stopWatcher']
  private readonly removeSessions?: GroupServiceDeps['removeSessions']
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: GroupServiceDeps) {
    this.db = deps.db
    this.repo = deps.groupsRepo
    this.appDataDir = deps.appDataDir
    this.exportKnowledge = deps.exportKnowledge
    this.withStorageLock = deps.withStorageLock ?? ((_id, task) => task())
    this.stopWatcher = deps.stopWatcher
    this.removeSessions = deps.removeSessions
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => ulid(this.now()))
  }

  list(): Group[] {
    return this.repo.list().map(toGroup)
  }

  async create(rawName: string): Promise<Group> {
    const name = this.validName(rawName)
    const nameKey = groupNameKey(name)
    if (this.repo.getByNameKey(nameKey)) throw new AppErrorException('GROUP_NAME_DUPLICATE')

    const timestamp = this.now()
    const sortOrder = this.repo.list().reduce((max, g) => Math.max(max, g.sortOrder), -1) + 1
    const row = {
      id: this.newId(),
      name,
      nameKey,
      sortOrder,
      createdAt: timestamp,
      updatedAt: timestamp
    }

    try {
      this.db.transaction((tx) => {
        new GroupsRepo(tx).insert(row)
        const sectionsRepo = new SectionsRepo(tx)
        BUILT_IN_SECTIONS.forEach((def, index) => {
          sectionsRepo.insert({
            id: ulid(timestamp),
            groupId: row.id,
            kind: def.kind,
            name: def.name,
            nameKey: sectionNameKey(def.name),
            folderName: def.folder,
            sortOrder: index,
            createdAt: timestamp
          })
        })
        new KnowledgeStorageRepo(tx).insert({
          groupId: row.id,
          mode: 'app',
          linkedPath: null,
          updatedAt: timestamp
        })
      })
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppErrorException('GROUP_NAME_DUPLICATE')
      throw error
    }

    try {
      const root = join(this.appDataDir, 'groups', row.id, 'knowledge')
      await mkdir(root, { recursive: true })
      for (const def of BUILT_IN_SECTIONS) {
        if (def.folder) await mkdir(join(root, def.folder), { recursive: true })
      }
    } catch {
      this.repo.delete(row.id)
      throw new AppErrorException('IO_FAILED')
    }
    return toGroup(row)
  }

  rename(groupId: string, rawName: string): Group {
    const name = this.validName(rawName)
    const existing = this.repo.getById(groupId)
    if (!existing) throw new AppErrorException('INTERNAL')

    const nameKey = groupNameKey(name)
    const clash = this.repo.getByNameKey(nameKey)
    if (clash && clash.id !== groupId) throw new AppErrorException('GROUP_NAME_DUPLICATE')

    const updatedAt = this.now()
    try {
      this.repo.update(groupId, { name, nameKey, updatedAt })
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppErrorException('GROUP_NAME_DUPLICATE')
      throw error
    }
    return toGroup({ ...existing, name, nameKey, updatedAt })
  }

  /**
   * Deletes a group. With `exportTo`, the knowledge is exported and verified first; if that fails
   * nothing is deleted. Only the app-managed `groups/<id>/` folder is removed, so a linked
   * knowledge folder and the user's project folders are never touched.
   */
  async delete(groupId: string, exportTo?: string): Promise<void> {
    const existing = this.repo.getById(groupId)
    if (!existing) throw new AppErrorException('INTERNAL')
    if (exportTo !== undefined) {
      if (!this.exportKnowledge) throw new AppErrorException('INTERNAL')
      await this.exportKnowledge(groupId, exportTo)
    }
    await this.withStorageLock(groupId, async () => {
      await this.stopWatcher?.(groupId)
      await this.removeSessions?.(groupId)
      this.db.transaction((tx) => {
        new GroupsRepo(tx).delete(groupId)
        // group_projects rows cascade with the group; drop projects left with no membership.
        new ProjectsRepo(tx).deleteOrphans()
      })
      // removeAppGroupDir only ever resolves <appData>/groups/<id>, whatever the storage mode.
      try {
        await removeAppGroupDir(this.appDataDir, groupId)
      } catch (error: unknown) {
        if (error instanceof AppErrorException) throw error
        throw new AppErrorException('IO_FAILED')
      }
    })
  }

  private validName(rawName: string): string {
    const name = normalizeGroupName(rawName)
    if (name.length === 0) throw new AppErrorException('GROUP_NAME_REQUIRED')
    if ([...name].length > GROUP_NAME_MAX) throw new AppErrorException('GROUP_NAME_TOO_LONG')
    return name
  }
}
