import { itemDraft } from './item-draft.svelte'
import { knowledge } from './knowledge.svelte'
import { ui } from './ui.svelte'

export type LeaveChoice = 'keep' | 'discard' | 'cancel'

export interface LeavePrompt {
  /** `changed`: disk differs from the editor. `deleted`: the file is gone. */
  kind: 'changed' | 'deleted'
  title: string
  answer: (choice: LeaveChoice) => void
}

/**
 * Stops navigation from silently dropping local text that autosave could not write.
 * Normal unsaved edits are not asked about: they are flushed when the item closes.
 */
class LeaveGuard {
  prompt = $state<LeavePrompt | null>(null)

  /** Resolves true when it is safe to leave the open item (nothing blocked, or the user chose). */
  async proceed(): Promise<boolean> {
    if (!itemDraft.hasConflict) return true
    if (this.prompt !== null) return false
    const kind = itemDraft.external === 'deleted' ? 'deleted' : 'changed'
    const title = itemDraft.title || 'this item'
    const choice = await new Promise<LeaveChoice>((resolve) => {
      this.prompt = { kind, title, answer: resolve }
    })
    this.prompt = null
    if (choice === 'cancel') return false
    if (choice === 'discard') {
      itemDraft.discard()
      return true
    }
    if (kind === 'changed') {
      await itemDraft.keepMine()
      return !itemDraft.hasConflict && !itemDraft.dirty
    }
    const sectionId = knowledge.sectionId
    if (sectionId === null) return false
    const result = await itemDraft.saveAsNew(sectionId, title)
    if ('code' in result) return false
    await knowledge.afterCountChange()
    return true
  }

  async selectItem(id: string | null): Promise<void> {
    if (id === ui.selectedItemId) return
    if (await this.proceed()) ui.selectItem(id)
  }

  async selectSection(id: string | null): Promise<boolean> {
    if (!(await this.proceed())) return false
    ui.selectSection(id)
    return true
  }

  /** Resolves false when the guard refused; selecting the group already shown counts as success. */
  async selectGroup(id: string | null): Promise<boolean> {
    if (id === ui.selectedGroupId) return true
    if (!(await this.proceed())) return false
    ui.selectGroup(id)
    return true
  }
}

export const leaveGuard = new LeaveGuard()
