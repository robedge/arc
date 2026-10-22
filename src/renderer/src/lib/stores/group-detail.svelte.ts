import type { AppError, Result } from '@shared/errors'
import type { Section } from '@shared/types/section'
import type { AddProjectsResult, Project } from '@shared/types/project'

class GroupDetailStore {
  groupId = $state<string | null>(null)
  sections = $state<Section[]>([])
  projects = $state<Project[]>([])

  /** Monotonic token so a late response for a previous group is ignored. */
  private requestId = 0

  /** Loads the sections of a group; null clears. Late responses are dropped. */
  async load(groupId: string | null): Promise<void> {
    const request = ++this.requestId
    if (groupId !== this.groupId) {
      this.sections = []
      this.projects = []
    }
    this.groupId = groupId
    if (groupId === null) return
    const [sections, projects] = await Promise.all([
      window.harness.invoke('sections:list', { groupId }),
      window.harness.invoke('projects:list', { groupId })
    ])
    if (request !== this.requestId) return
    if (sections.ok && Array.isArray(sections.data)) this.sections = sections.data
    if (projects.ok && Array.isArray(projects.data)) this.projects = projects.data
  }

  /** Patches a loaded project's availability in place; other groups are ignored. */
  applyAvailability(event: {
    groupId: string
    projectId?: string
    knowledgeRoot?: boolean
    available: boolean
  }): void {
    if (event.groupId !== this.groupId || event.projectId === undefined) return
    const target = this.projects.find((p) => p.id === event.projectId)
    if (target) target.available = event.available
  }

  /** Re-points a missing project via the main-process folder picker. */
  async relocateProject(projectId: string): Promise<AppError | null> {
    if (this.groupId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('projects:relocate', {
      groupId: this.groupId,
      projectId
    })
    if (!res.ok) return res.error
    await this.reload()
    return null
  }

  private reload(): Promise<void> {
    return this.load(this.groupId)
  }

  async createSection(name: string): Promise<Section | AppError> {
    if (this.groupId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('sections:create', { groupId: this.groupId, name })
    if (!res.ok) return res.error
    await this.reload()
    return res.data
  }

  async renameSection(sectionId: string, name: string): Promise<Section | AppError> {
    const res = await window.harness.invoke('sections:rename', { sectionId, name })
    if (!res.ok) return res.error
    await this.reload()
    return res.data
  }

  /** Returns an error on failure, else null. */
  async deleteSection(sectionId: string): Promise<AppError | null> {
    const res = await window.harness.invoke('sections:delete', { sectionId })
    if (!res.ok) return res.error
    await this.reload()
    return null
  }

  /** Adds folders by path; returns the result (with skipped items) or an error. */
  async addProjects(paths: string[]): Promise<AddProjectsResult | AppError> {
    if (this.groupId === null || paths.length === 0) return { added: [], skipped: [] }
    const res = await window.harness.invoke('projects:add', { groupId: this.groupId, paths })
    return this.afterAdd(res)
  }

  /** Opens the native folder picker in main and adds the chosen folders. */
  async pickProjects(): Promise<AddProjectsResult | AppError> {
    if (this.groupId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('projects:pick', { groupId: this.groupId })
    return this.afterAdd(res)
  }

  private async afterAdd(res: Result<AddProjectsResult>): Promise<AddProjectsResult | AppError> {
    if (!res.ok) return res.error
    await this.reload()
    return res.data
  }

  async removeProject(projectId: string): Promise<AppError | null> {
    if (this.groupId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('projects:remove', {
      groupId: this.groupId,
      projectId
    })
    if (!res.ok) return res.error
    await this.reload()
    return null
  }
}

export const groupDetail = new GroupDetailStore()
