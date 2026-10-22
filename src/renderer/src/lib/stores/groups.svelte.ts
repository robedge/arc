import type { AppError } from '@shared/errors'
import type { Group } from '@shared/types/group'

class GroupsStore {
  list = $state<Group[]>([])

  async load(): Promise<void> {
    const res = await window.harness.invoke('groups:list', {})
    if (res.ok) this.list = res.data
  }

  /** Creates a group, refetches the list, and returns the group or the error. */
  async create(name: string): Promise<Group | AppError> {
    const res = await window.harness.invoke('groups:create', { name })
    if (!res.ok) return res.error
    await this.load()
    return res.data
  }

  /** Renames a group, refetches the list, and returns the group or the error. */
  async rename(groupId: string, name: string): Promise<Group | AppError> {
    const res = await window.harness.invoke('groups:rename', { groupId, name })
    if (!res.ok) return res.error
    await this.load()
    return res.data
  }

  /** Deletes a group and refetches the list. Returns an error on failure, else null. */
  async remove(groupId: string): Promise<AppError | null> {
    const res = await window.harness.invoke('groups:delete', { groupId })
    if (!res.ok) return res.error
    await this.load()
    return null
  }
}

export const groups = new GroupsStore()
