import type { StorageState } from '@shared/types/storage'
import type { AppServices } from '../../app/app-services'
import { handle } from '../register'
import { notifyGroupChanged } from './group-changed'

type StorageServices = Pick<
  AppServices,
  'storageService' | 'sectionService' | 'availability' | 'sessions'
>

export function registerStorageHandlers(services: StorageServices): void {
  const { storageService, sectionService, availability, sessions } = services
  // Whatever status the renderer is given becomes the baseline the next availability check compares to.
  const reportStorage = (groupId: string, state: StorageState): StorageState => {
    availability.recordKnowledgeBaseline(groupId, state.mode === 'linked' ? state.available : null)
    return state
  }
  const knowledgeChanged = (groupId: string): void =>
    notifyGroupChanged(sessions, groupId, { kind: 'knowledge' })

  handle('storage:get', async ({ groupId }) =>
    reportStorage(groupId, await storageService.getState(groupId))
  )
  handle('storage:pick-folder', ({ groupId }) => storageService.pickFolder(groupId))
  handle('storage:link', async ({ groupId, token, choice }) => {
    const state = reportStorage(groupId, await storageService.link(groupId, token, choice))
    knowledgeChanged(groupId)
    return state
  })
  handle('storage:unlink', async ({ groupId, choice }) => {
    const state = reportStorage(groupId, await storageService.unlink(groupId, choice))
    knowledgeChanged(groupId)
    return state
  })
  handle('storage:locate', async ({ groupId }) => {
    const result = await storageService.locate(groupId)
    if (result.located) {
      reportStorage(groupId, result.state)
      knowledgeChanged(groupId)
    }
    return result
  })
  handle('storage:use-app-storage', async ({ groupId }) => {
    const state = reportStorage(groupId, await storageService.useAppStorage(groupId))
    knowledgeChanged(groupId)
    return state
  })
  handle('storage:pick-export-folder', ({ groupId }) => storageService.pickExportFolder(groupId))
  handle('storage:export', ({ groupId, token }) => storageService.exportKnowledge(groupId, token))
  handle('sections:list', ({ groupId }) => sectionService.list(groupId))
  handle('sections:create', ({ groupId, name }) => sectionService.create(groupId, name))
  handle('sections:rename', ({ sectionId, name }) => sectionService.rename(sectionId, name))
  handle('sections:delete', ({ sectionId }) => sectionService.delete(sectionId))
}
