import { join } from 'node:path'
import { openDatabase } from '../../../src/main/db/client'
import type { OpenedDatabase } from '../../../src/main/db/client'
import { GroupsRepo } from '../../../src/main/db/repositories/groups-repo'
import { KnowledgeItemsRepo } from '../../../src/main/db/repositories/knowledge-items-repo'
import { KnowledgeStorageRepo } from '../../../src/main/db/repositories/knowledge-storage-repo'
import { SectionsRepo } from '../../../src/main/db/repositories/sections-repo'
import { GroupService } from '../../../src/main/groups/group-service'
import { KnowledgeIndex } from '../../../src/main/knowledge/knowledge-index'
import { KnowledgeService } from '../../../src/main/knowledge/knowledge-service'
import { createKnowledgeRootResolver } from '../../../src/main/knowledge/knowledge-root'
import { MetaStore } from '../../../src/main/knowledge/meta-store'
import { SectionService } from '../../../src/main/knowledge/section-service'
import { AppErrorException } from '../../../src/shared/errors'
import type { ErrorCode } from '../../../src/shared/errors'
import { realMigrations } from '../db/helpers'

export interface KnowledgeEnv {
  opened: OpenedDatabase
  groupId: string
  root: string
  notesId: string
  index: KnowledgeIndex
  service: KnowledgeService
  sections: SectionService
  itemsRepo: KnowledgeItemsRepo
  sectionsRepo: SectionsRepo
  metaStore: MetaStore
}

export async function createEnv(dir: string): Promise<KnowledgeEnv> {
  const userData = join(dir, 'userData')
  const opened = openDatabase({ dbPath: join(dir, 'arc.db'), migrationsFolder: realMigrations })
  const groups = new GroupService({
    db: opened.db,
    groupsRepo: new GroupsRepo(opened.db),
    appDataDir: userData
  })
  const groupId = (await groups.create('Storefront')).id
  const sectionsRepo = new SectionsRepo(opened.db)
  const itemsRepo = new KnowledgeItemsRepo(opened.db)
  const metaStore = new MetaStore({ log: { warn: () => undefined } })
  const getKnowledgeRoot = createKnowledgeRootResolver({
    storageRepo: new KnowledgeStorageRepo(opened.db),
    appDataDir: userData
  })
  const index = new KnowledgeIndex({ sectionsRepo, itemsRepo, metaStore, getKnowledgeRoot })
  const notes = sectionsRepo.listByGroup(groupId).find((s) => s.kind === 'notes')
  if (!notes) throw new Error('no notes section')
  return {
    opened,
    groupId,
    root: join(userData, 'groups', groupId, 'knowledge'),
    notesId: notes.id,
    index,
    itemsRepo,
    sectionsRepo,
    metaStore,
    service: new KnowledgeService({ sectionsRepo, itemsRepo, index, metaStore, getKnowledgeRoot }),
    sections: new SectionService({ sectionsRepo, getKnowledgeRoot, metaStore })
  }
}

export async function codeOf(p: Promise<unknown>): Promise<ErrorCode | undefined> {
  try {
    await p
  } catch (error: unknown) {
    if (error instanceof AppErrorException) return error.code
    throw error
  }
  return undefined
}
