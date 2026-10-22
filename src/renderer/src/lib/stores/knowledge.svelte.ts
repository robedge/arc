import { ITEM_TITLE_MAX } from '@shared/limits'
import type { AppError } from '@shared/errors'
import type { KnowledgeChangedPayload } from '@shared/ipc/contract'
import type { ItemSummary } from '@shared/types/item'
import { messageFor } from '../ipc/messages'
import { groupDetail } from './group-detail.svelte'
import { itemDraft } from './item-draft.svelte'
import { ui } from './ui.svelte'

export const KNOWLEDGE_REFRESH_DEBOUNCE_MS = 150

/** Client-side title check shared by the create dialog and the inline rename. */
export function validateItemTitle(raw: string): string | null {
  const title = raw.trim()
  if (title.length === 0) return messageFor({ code: 'TITLE_REQUIRED' })
  if ([...title].length > ITEM_TITLE_MAX) return messageFor({ code: 'VALIDATION_FAILED' })
  return null
}

class KnowledgeStore {
  sectionId = $state<string | null>(null)
  items = $state<ItemSummary[]>([])

  /** Monotonic token so a late response for a previous section is ignored. */
  private requestId = 0
  private changeTimer: ReturnType<typeof setTimeout> | null = null
  private pending: {
    groupId: string
    sectionIds: Set<string>
    sectionsChanged: boolean
    /** False when any coalesced event omitted `items` (too many to list). */
    enumerated: boolean
    items: Map<string, string | null>
  } | null = null

  async load(sectionId: string | null): Promise<void> {
    const request = ++this.requestId
    if (sectionId !== this.sectionId) this.items = []
    this.sectionId = sectionId
    if (sectionId === null) return
    const res = await window.harness.invoke('items:list', { sectionId })
    if (request !== this.requestId) return
    if (res.ok && Array.isArray(res.data)) this.items = res.data
  }

  refresh(): Promise<void> {
    return this.load(this.sectionId)
  }

  async create(title: string, description?: string): Promise<ItemSummary | AppError> {
    if (this.sectionId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('items:create', {
      sectionId: this.sectionId,
      title,
      ...(description ? { description } : {})
    })
    if (!res.ok) return res.error
    await this.afterCountChange()
    return res.data
  }

  /** Adds a link, or edits the one named by `itemId`. */
  async upsertLink(
    values: { url: string; title: string; description: string },
    itemId?: string
  ): Promise<ItemSummary | AppError> {
    if (this.sectionId === null) return { code: 'INTERNAL' }
    const res = await window.harness.invoke('links:upsert', {
      sectionId: this.sectionId,
      ...(itemId ? { itemId } : {}),
      url: values.url.trim(),
      ...(values.title.trim() ? { title: values.title.trim() } : {}),
      ...(values.description.trim() ? { description: values.description.trim() } : {})
    })
    if (!res.ok) return res.error
    await (itemId ? this.refresh() : this.afterCountChange())
    return res.data
  }

  async rename(itemId: string, title: string): Promise<ItemSummary | AppError> {
    const res = await window.harness.invoke('items:rename', { itemId, title })
    if (!res.ok) return res.error
    await this.refresh()
    return res.data
  }

  async setDescription(itemId: string, description: string): Promise<AppError | null> {
    const res = await window.harness.invoke('items:setDescription', { itemId, description })
    if (!res.ok) return res.error
    await this.refresh()
    return null
  }

  async remove(itemId: string): Promise<AppError | null> {
    const res = await window.harness.invoke('items:delete', { itemId })
    if (!res.ok) return res.error
    await this.afterCountChange()
    return null
  }

  /**
   * Push handler for `knowledge:changed`: coalesces events over 150 ms, reconciles the open
   * item first (so a deleted file keeps its banner), then refreshes sections and the list.
   */
  handleChanged(payload: KnowledgeChangedPayload): void {
    if (payload.groupId !== groupDetail.groupId) return
    const pending = this.pending
    if (pending === null || pending.groupId !== payload.groupId) {
      this.pending = {
        groupId: payload.groupId,
        sectionIds: new Set(payload.sectionIds),
        sectionsChanged: payload.sectionsChanged === true,
        enumerated: payload.items !== undefined,
        items: new Map((payload.items ?? []).map((i) => [i.id, i.revision]))
      }
    } else {
      for (const id of payload.sectionIds) pending.sectionIds.add(id)
      if (payload.sectionsChanged) pending.sectionsChanged = true
      if (payload.items === undefined) pending.enumerated = false
      for (const i of payload.items ?? []) pending.items.set(i.id, i.revision)
    }
    if (this.changeTimer !== null) clearTimeout(this.changeTimer)
    this.changeTimer = setTimeout(() => void this.applyChanges(), KNOWLEDGE_REFRESH_DEBOUNCE_MS)
  }

  private async applyChanges(): Promise<void> {
    const pending = this.pending
    this.pending = null
    this.changeTimer = null
    if (pending === null || pending.groupId !== groupDetail.groupId) return

    const openId = itemDraft.itemId
    if (openId !== null) {
      if (pending.items.has(openId)) {
        await itemDraft.applyExternal(openId, pending.items.get(openId) ?? null)
      } else if (!pending.enumerated) {
        await itemDraft.recheck()
      }
    }

    // Section counts live in groupDetail; this also adopts newly discovered sections.
    const tasks: Promise<void>[] = [groupDetail.load(pending.groupId)]
    if (this.sectionId !== null && pending.sectionIds.has(this.sectionId)) {
      tasks.push(this.refresh())
    }
    await Promise.all(tasks)
  }

  /** Deleted-on-disk banner, "Save as new": the editor text becomes a new item that is selected. */
  async saveDeletedAsNew(sectionId: string, title: string): Promise<AppError | null> {
    const result = await itemDraft.saveAsNew(sectionId, title)
    if ('code' in result) return result
    await this.afterCountChange()
    ui.selectItem(result.id)
    return null
  }

  /** Deleted-on-disk banner, "Close": drops the draft and deselects the item. */
  closeDeleted(): void {
    itemDraft.discard()
    ui.selectItem(null)
  }

  /** Section item counts live in groupDetail (used by the delete-section confirm). */
  async afterCountChange(): Promise<void> {
    await Promise.all([this.refresh(), groupDetail.load(groupDetail.groupId)])
  }
}

export const knowledge = new KnowledgeStore()
