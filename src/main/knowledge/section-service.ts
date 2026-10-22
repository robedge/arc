import { mkdir, readdir, rename, rm } from 'node:fs/promises'
import { AppErrorException } from '@shared/errors'
import { SECTION_NAME_MAX } from '@shared/limits'
import { CUSTOM_SECTION_SORT_START, sectionNameKey } from '@shared/sections'
import type { Section } from '@shared/types/section'
import { ulid } from '../db/ids'
import { isUniqueViolation } from '../db/repositories/groups-repo'
import type { SectionRow, SectionsRepo } from '../db/repositories/sections-repo'
import { listSectionFiles } from './knowledge-index'
import { isNonKnowledgeFolder } from './section-scan'
import type { MetaStore } from './meta-store'
import { resolveInRoot, sanitizeName, uniqueName } from './knowledge-paths'

export interface SectionServiceDeps {
  sectionsRepo: SectionsRepo
  getKnowledgeRoot: (groupId: string) => string
  metaStore: MetaStore
  log?: { warn: (...args: unknown[]) => void }
  now?: () => number
  newId?: () => string
}

function fold(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

export class SectionService {
  private readonly repo: SectionsRepo
  private readonly getRoot: (groupId: string) => string
  private readonly meta: MetaStore
  private readonly log: { warn: (...args: unknown[]) => void }
  private readonly now: () => number
  private readonly newId: () => string

  constructor(deps: SectionServiceDeps) {
    this.repo = deps.sectionsRepo
    this.getRoot = deps.getKnowledgeRoot
    this.meta = deps.metaStore
    this.log = deps.log ?? { warn: () => undefined }
    this.now = deps.now ?? Date.now
    this.newId = deps.newId ?? (() => ulid(this.now()))
  }

  async list(groupId: string): Promise<Section[]> {
    const rows = this.repo.listByGroup(groupId)
    return Promise.all(rows.map((row) => this.toDto(row)))
  }

  async create(groupId: string, rawName: string): Promise<Section> {
    const name = this.validName(rawName)
    const nameKey = sectionNameKey(name)
    if (this.repo.getByGroupAndNameKey(groupId, nameKey)) {
      throw new AppErrorException('SECTION_NAME_DUPLICATE')
    }
    const desired = sanitizeName(name)
    if (!desired) throw new AppErrorException('SECTION_NAME_INVALID')

    const root = this.getRoot(groupId)
    const folderName = uniqueName(await this.listEntries(root), desired)
    const row = {
      id: this.newId(),
      groupId,
      kind: 'custom' as const,
      name,
      nameKey,
      folderName,
      sortOrder: (this.repo.maxCustomSortOrder(groupId) ?? CUSTOM_SECTION_SORT_START - 1) + 1,
      createdAt: this.now()
    }
    try {
      this.repo.insert(row)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new AppErrorException('SECTION_NAME_DUPLICATE')
      throw error
    }
    try {
      await mkdir(await resolveInRoot(root, [folderName]), { recursive: true })
    } catch {
      this.repo.delete(row.id)
      throw new AppErrorException('IO_FAILED')
    }
    await this.mirrorMeta(groupId)
    return this.toDto(row)
  }

  /**
   * Adopts subfolders that appeared in the knowledge root (created outside the app) as custom
   * sections. Folders already backing a section (compared NFC + case-folded) and dot-folders are
   * skipped. The display name comes from meta.json when it names the folder, else the folder name,
   * made unique. Returns the new sections.
   */
  async adoptFolders(groupId: string): Promise<Section[]> {
    const root = this.getRoot(groupId)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      return []
    }
    const known = new Set(
      this.repo
        .listByGroup(groupId)
        .map((r) => r.folderName)
        .filter((f): f is string => f !== null)
        .map(fold)
    )
    const fresh = entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith('.') &&
          !isNonKnowledgeFolder(e.name) &&
          !known.has(fold(e.name))
      )
      .map((e) => e.name)
      .sort()
    if (fresh.length === 0) return []
    const meta = await this.meta.read(root).catch(() => null)
    const added: SectionRow[] = []
    for (const folderName of fresh) {
      const metaName = meta?.sections.find((s) => s.folder === folderName)?.name
      const row = this.insertAdopted(groupId, folderName, metaName)
      if (row) added.push(row)
    }
    if (added.length > 0) await this.mirrorMeta(groupId)
    return Promise.all(added.map((row) => this.toDto(row)))
  }

  private insertAdopted(
    groupId: string,
    folderName: string,
    metaName: string | undefined
  ): SectionRow | null {
    const trim = (n: string): string =>
      [...n.trim().normalize('NFC')].slice(0, SECTION_NAME_MAX).join('')
    const base = trim(metaName ?? '') || trim(folderName)
    if (!base) return null
    for (let n = 1; n < 100; n++) {
      const suffix = n === 1 ? '' : ` (${n})`
      const name = [...base].slice(0, SECTION_NAME_MAX - suffix.length).join('') + suffix
      const nameKey = sectionNameKey(name)
      if (this.repo.getByGroupAndNameKey(groupId, nameKey)) continue
      const row: SectionRow = {
        id: this.newId(),
        groupId,
        kind: 'custom',
        name,
        nameKey,
        folderName,
        sortOrder: (this.repo.maxCustomSortOrder(groupId) ?? CUSTOM_SECTION_SORT_START - 1) + 1,
        createdAt: this.now()
      }
      try {
        this.repo.insert(row)
        return row
      } catch (error: unknown) {
        if (!isUniqueViolation(error)) throw error
      }
    }
    return null
  }

  async rename(sectionId: string, rawName: string): Promise<Section> {
    const existing = this.requireCustom(sectionId)
    const name = this.validName(rawName)
    const nameKey = sectionNameKey(name)
    const clash = this.repo.getByGroupAndNameKey(existing.groupId, nameKey)
    if (clash && clash.id !== sectionId) throw new AppErrorException('SECTION_NAME_DUPLICATE')
    const desired = sanitizeName(name)
    if (!desired) throw new AppErrorException('SECTION_NAME_INVALID')

    const root = this.getRoot(existing.groupId)
    const oldFolder = existing.folderName ?? ''
    let newFolder = oldFolder
    if (desired !== oldFolder) {
      const others = (await this.listEntries(root)).filter((e) => fold(e) !== fold(oldFolder))
      newFolder = uniqueName(others, desired)
    }

    if (newFolder !== oldFolder) {
      try {
        await this.moveFolder(root, oldFolder, newFolder)
      } catch (error: unknown) {
        if (error instanceof AppErrorException) throw error
        throw new AppErrorException('IO_FAILED')
      }
    }
    try {
      this.repo.update(sectionId, { name, nameKey, folderName: newFolder })
    } catch (error: unknown) {
      if (newFolder !== oldFolder) {
        await this.moveFolder(root, newFolder, oldFolder).catch(() => undefined)
      }
      if (isUniqueViolation(error)) throw new AppErrorException('SECTION_NAME_DUPLICATE')
      throw error
    }
    await this.mirrorMeta(existing.groupId)
    return this.toDto({ ...existing, name, nameKey, folderName: newFolder })
  }

  async delete(sectionId: string): Promise<{ removed: number }> {
    const existing = this.requireCustom(sectionId)
    const root = this.getRoot(existing.groupId)
    const removed = await this.countItems(root, existing.folderName)
    try {
      if (existing.folderName) {
        const target = await resolveInRoot(root, [existing.folderName])
        await rm(target, { recursive: true, force: true })
      }
    } catch (error: unknown) {
      if (error instanceof AppErrorException) throw error
      throw new AppErrorException('IO_FAILED')
    }
    this.repo.delete(sectionId)
    await this.mirrorMeta(existing.groupId)
    return { removed }
  }

  private requireCustom(sectionId: string): SectionRow {
    const row = this.repo.getById(sectionId)
    if (!row) throw new AppErrorException('INTERNAL')
    if (row.kind !== 'custom' || !row.folderName) throw new AppErrorException('VALIDATION_FAILED')
    return row
  }

  private validName(rawName: string): string {
    const name = rawName.trim().normalize('NFC')
    const length = [...name].length
    if (length < 1 || length > SECTION_NAME_MAX) throw new AppErrorException('SECTION_NAME_INVALID')
    return name
  }

  /** Moves a folder; a case-only change goes through a temporary name so case-insensitive disks honor it. */
  private async moveFolder(root: string, from: string, to: string): Promise<void> {
    const source = await resolveInRoot(root, [from])
    const dest = await resolveInRoot(root, [to])
    try {
      if (fold(from) === fold(to)) {
        const temp = await resolveInRoot(root, [`${from}.rename-tmp-${this.randomSuffix()}`])
        await rename(source, temp)
        await rename(temp, dest)
      } else {
        await rename(source, dest)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(dest, { recursive: true }) // folder was removed externally; recreate under the new name
    }
  }

  private randomSuffix(): string {
    return Math.random().toString(36).slice(2, 10)
  }

  private async listEntries(root: string): Promise<string[]> {
    try {
      return await readdir(root)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
      }
      throw error
    }
  }

  private async countItems(root: string, folderName: string | null): Promise<number> {
    if (!folderName) return 0 // Projects: counted once projects exist (Slice 4)
    return (await listSectionFiles(root, folderName)).length
  }

  private async toDto(row: SectionRow): Promise<Section> {
    let itemCount = 0
    if (row.folderName) {
      try {
        itemCount = await this.countItems(this.getRoot(row.groupId), row.folderName)
      } catch {
        itemCount = 0
      }
    }
    return {
      id: row.id,
      groupId: row.groupId,
      kind: row.kind,
      name: row.name,
      builtIn: row.kind !== 'custom',
      itemCount,
      sortOrder: row.sortOrder
    }
  }

  /** Keeps meta.json's section list in step with the registry. The database stays authoritative. */
  private async mirrorMeta(groupId: string): Promise<void> {
    try {
      const root = this.getRoot(groupId)
      const rows = this.repo.listByGroup(groupId).filter((r) => r.folderName)
      await this.meta.updateMeta(root, (meta) => {
        meta.sections = rows.map((r) => ({
          folder: r.folderName ?? '',
          name: r.name,
          kind: r.kind
        }))
      })
    } catch (error: unknown) {
      this.log.warn('failed to update meta.json sections', error)
    }
  }
}
