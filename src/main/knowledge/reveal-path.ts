import { stat } from 'node:fs/promises'
import { AppErrorException } from '@shared/errors'
import type { KnowledgeItemsRepo } from '../db/repositories/knowledge-items-repo'
import type { SectionsRepo } from '../db/repositories/sections-repo'
import { resolveInRoot } from './knowledge-paths'

export interface RevealTarget {
  groupId: string
  sectionId?: string | undefined
  itemId?: string | undefined
}

export interface RevealPath {
  path: string
  isDirectory: boolean
}

export interface RevealResolverDeps {
  sectionsRepo: Pick<SectionsRepo, 'getById'>
  itemsRepo: Pick<KnowledgeItemsRepo, 'getById'>
  getKnowledgeRoot: (groupId: string) => string
}

/**
 * Resolves ids to an absolute path main may show in Finder: an item file, a section folder, or
 * the group's knowledge root. The renderer never supplies a path; ids must belong to `groupId`.
 */
export function createRevealResolver(
  deps: RevealResolverDeps
): (target: RevealTarget) => Promise<RevealPath> {
  return async ({ groupId, sectionId, itemId }) => {
    const root = deps.getKnowledgeRoot(groupId)
    let segments: string[] = []
    if (itemId !== undefined) {
      const item = deps.itemsRepo.getById(itemId)
      if (!item || item.groupId !== groupId) throw new AppErrorException('VALIDATION_FAILED')
      segments = item.relPath.split('/')
    } else if (sectionId !== undefined) {
      const section = deps.sectionsRepo.getById(sectionId)
      if (!section || section.groupId !== groupId || !section.folderName) {
        throw new AppErrorException('VALIDATION_FAILED')
      }
      segments = [section.folderName]
    }
    const path = segments.length > 0 ? await resolveInRoot(root, segments) : root
    try {
      return { path, isDirectory: (await stat(path)).isDirectory() }
    } catch {
      throw new AppErrorException(segments.length > 0 ? 'FOLDER_MISSING' : 'KNOWLEDGE_ROOT_MISSING')
    }
  }
}
