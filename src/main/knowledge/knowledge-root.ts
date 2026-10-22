import { join } from 'node:path'
import { AppErrorException } from '@shared/errors'
import type { KnowledgeStorageRepo } from '../db/repositories/knowledge-storage-repo'

/** Where a group's knowledge lives: the app-managed folder, or the linked folder in linked mode. */
export function createKnowledgeRootResolver(deps: {
  storageRepo: Pick<KnowledgeStorageRepo, 'get'>
  appDataDir: string
}): (groupId: string) => string {
  return (groupId) => {
    const row = deps.storageRepo.get(groupId)
    if (!row) throw new AppErrorException('KNOWLEDGE_ROOT_MISSING')
    if (row.mode === 'linked' && row.linkedPath) return row.linkedPath
    return join(deps.appDataDir, 'groups', groupId, 'knowledge')
  }
}
