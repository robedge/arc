import type { Project } from '@shared/types/project'
import type { AppServices } from '../../app/app-services'
import { knowledgeLog } from '../../logging'
import { handle } from '../register'
import { notifyGroupChanged } from './group-changed'

type GroupServices = Pick<
  AppServices,
  'groupService' | 'knowledgeIndex' | 'knowledgeWatcher' | 'availability'
>

type ProjectServices = Pick<AppServices, 'projectService' | 'availability' | 'sessions'>

export function registerGroupHandlers(services: GroupServices): void {
  const { groupService, knowledgeIndex, knowledgeWatcher, availability } = services
  handle('groups:list', () => groupService.list())
  handle('groups:create', ({ name }) => groupService.create(name))
  handle('groups:rename', ({ groupId, name }) => groupService.rename(groupId, name))
  handle('groups:delete', ({ groupId, exportTo }) => groupService.delete(groupId, exportTo))
  handle('groups:open', async ({ groupId }) => {
    await knowledgeIndex.reconcileGroup(groupId).catch((e: unknown) => {
      knowledgeLog.warn('reconcile on group open failed', e)
    })
    await knowledgeWatcher.start(groupId)
    return availability.setOpenGroup(groupId)
  })
}

export function registerProjectHandlers(services: ProjectServices): void {
  const { projectService, availability, sessions } = services
  const recordBaselines = (projects: Project[]): void => {
    for (const p of projects) availability.recordBaseline(p.id, p.available)
  }
  handle('projects:list', async ({ groupId }) => {
    const projects = await projectService.list(groupId)
    recordBaselines(projects)
    return projects
  })
  handle('projects:pick', async ({ groupId }) => {
    const result = await projectService.pick(groupId)
    recordBaselines(result.added)
    if (result.added.length > 0) notifyGroupChanged(sessions, groupId, { kind: 'projects' })
    return result
  })
  handle('projects:add', async ({ groupId, paths }) => {
    const result = await projectService.add(groupId, paths)
    recordBaselines(result.added)
    if (result.added.length > 0) notifyGroupChanged(sessions, groupId, { kind: 'projects' })
    return result
  })
  handle('projects:remove', ({ groupId, projectId }) => {
    projectService.remove(groupId, projectId)
    notifyGroupChanged(sessions, groupId, { kind: 'projects' })
  })
  handle('projects:relocate', async ({ groupId, projectId }) => {
    const project = await projectService.relocate(groupId, projectId)
    recordBaselines([project])
    await availability.checkGroup(groupId)
    // A project can belong to several groups: its new folder reaches all of their sessions.
    notifyGroupChanged(sessions, null, { kind: 'projects' })
    return project
  })
}
