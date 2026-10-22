import type { AppError } from '@shared/errors'
import type { ItemSummary } from '@shared/types/item'
import { reconcileOpenItem } from '../reconcile'

export const AUTOSAVE_DELAY_MS = 600

export type DraftStatus = 'idle' | 'saving' | 'saved' | 'error' | 'conflict'

class ItemDraftStore {
  itemId = $state<string | null>(null)
  text = $state('')
  lastSavedRevision = $state('')
  dirty = $state(false)
  status = $state<DraftStatus>('idle')
  loading = $state(false)
  /** Set while the open item differs on disk and the user must choose; autosave is paused. */
  external = $state<'changed' | 'deleted' | null>(null)
  /** Title of the open item, kept for conflict prompts (the list may no longer hold it). */
  title = $state('')

  private timer: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<void> | null = null

  /**
   * Local text that cannot be autosaved because it conflicts with disk: an outside change or a
   * failed-revision save while dirty, or a file deleted on disk that still has text in the editor.
   */
  get hasConflict(): boolean {
    if (this.itemId === null) return false
    if (this.external === 'deleted') return this.text.length > 0
    return this.dirty && (this.external === 'changed' || this.status === 'conflict')
  }

  setTitle(title: string): void {
    this.title = title
  }

  /** Flushes the current draft, then loads another item (or none). */
  async open(itemId: string | null, title = ''): Promise<void> {
    if (itemId === this.itemId) return
    await this.flush()
    this.clearTimer()
    this.itemId = itemId
    this.text = ''
    this.lastSavedRevision = ''
    this.dirty = false
    this.status = 'idle'
    this.external = null
    this.title = title
    if (itemId === null) return
    this.loading = true
    const res = await window.harness.invoke('items:read', { itemId })
    if (this.itemId !== itemId) return
    this.loading = false
    if (res.ok && res.data.type === 'text') {
      this.text = res.data.content
      this.lastSavedRevision = res.data.revision
    } else {
      this.status = 'error'
    }
  }

  /** Records an edit and (re)starts the autosave debounce. */
  edit(text: string): void {
    if (this.itemId === null || text === this.text) return
    this.text = text
    this.dirty = true
    if (this.external !== null || this.status === 'conflict') return
    this.status = 'idle'
    this.clearTimer()
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS)
  }

  /** Saves immediately when there are unsaved edits. */
  async flush(): Promise<void> {
    this.clearTimer()
    if (this.inflight) await this.inflight
    if (!this.dirty || this.itemId === null || this.external !== null || this.status === 'conflict')
      return
    this.inflight = this.save(this.itemId, this.text)
    try {
      await this.inflight
    } finally {
      this.inflight = null
    }
  }

  /** Updates the base revision after a main-side change the app made itself (rename). */
  setRevision(itemId: string, revision: string): void {
    if (itemId === this.itemId) this.lastSavedRevision = revision
  }

  /** Drops unsaved edits without saving (the item is going away). */
  discard(): void {
    this.clearTimer()
    this.dirty = false
    this.itemId = null
    this.text = ''
    this.status = 'idle'
    this.external = null
    this.title = ''
  }

  /**
   * Applies a `knowledge:changed` revision for the open item (null = deleted).
   * A save in flight finishes first so the app's own write is not mistaken for an outside edit.
   */
  async applyExternal(itemId: string, incoming: string | null): Promise<void> {
    if (itemId !== this.itemId || this.loading) return
    if (this.inflight) await this.inflight.catch(() => {})
    if (itemId !== this.itemId) return
    const action = reconcileOpenItem({
      held: this.lastSavedRevision,
      dirty: this.dirty,
      incoming
    })
    if (action === 'ignore') return
    if (action === 'deleted') {
      this.clearTimer()
      this.external = 'deleted'
    } else if (action === 'conflict') {
      this.clearTimer()
      this.external = 'changed'
    } else {
      await this.loadFromDisk(itemId, true)
    }
  }

  /** Re-reads the open item and reconciles; used when a change was too large to enumerate. */
  async recheck(): Promise<void> {
    const itemId = this.itemId
    if (itemId === null || this.loading) return
    const res = await window.harness.invoke('items:read', { itemId })
    if (itemId !== this.itemId) return
    await this.applyExternal(itemId, res.ok && res.data.type === 'text' ? res.data.revision : null)
  }

  /** "Reload": discards local edits and shows what is on disk. */
  async reload(): Promise<void> {
    const itemId = this.itemId
    if (itemId === null) return
    if (!(await this.loadFromDisk(itemId, false))) this.external = 'deleted'
  }

  /** "Keep mine": adopts the current disk revision as the base and resumes autosave. */
  async keepMine(): Promise<void> {
    const itemId = this.itemId
    if (itemId === null) return
    const res = await window.harness.invoke('items:read', { itemId })
    if (itemId !== this.itemId) return
    if (!res.ok || res.data.type !== 'text') {
      this.external = 'deleted'
      return
    }
    this.lastSavedRevision = res.data.revision
    this.external = null
    this.status = 'idle'
    await this.flush()
  }

  /** Deleted on disk: saves the editor text as a new item in the same section. */
  async saveAsNew(sectionId: string, title: string): Promise<ItemSummary | AppError> {
    const text = this.text
    const created = await window.harness.invoke('items:create', { sectionId, title })
    if (!created.ok) return created.error
    const saved = await window.harness.invoke('items:save', {
      itemId: created.data.id,
      content: text,
      baseRevision: created.data.revision
    })
    if (!saved.ok) return saved.error
    this.discard()
    return created.data
  }

  /** Loads disk content into the editor; false when the item could not be read as text. */
  private async loadFromDisk(itemId: string, onlyIfClean: boolean): Promise<boolean> {
    const res = await window.harness.invoke('items:read', { itemId })
    if (itemId !== this.itemId) return true
    if (!res.ok || res.data.type !== 'text') return false
    if (onlyIfClean && this.dirty) {
      // Typed while the read was in flight: never overwrite, ask instead.
      this.clearTimer()
      this.external = 'changed'
      return true
    }
    this.clearTimer()
    this.text = res.data.content
    this.lastSavedRevision = res.data.revision
    this.dirty = false
    this.external = null
    this.status = 'idle'
    return true
  }

  private async save(itemId: string, text: string): Promise<void> {
    this.status = 'saving'
    const res = await window.harness.invoke('items:save', {
      itemId,
      content: text,
      baseRevision: this.lastSavedRevision
    })
    if (this.itemId !== itemId) return
    if (res.ok) {
      this.lastSavedRevision = res.data.revision
      if (this.text === text) {
        this.dirty = false
        this.status = 'saved'
      } else {
        this.status = 'idle'
        this.clearTimer()
        this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS)
      }
      return
    }
    this.status = errorStatus(res.error)
    if (res.error.code === 'EXTERNAL_MODIFIED') {
      this.clearTimer()
      this.external = 'changed'
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}

function errorStatus(error: AppError): DraftStatus {
  return error.code === 'EXTERNAL_MODIFIED' ? 'conflict' : 'error'
}

export const itemDraft = new ItemDraftStore()
