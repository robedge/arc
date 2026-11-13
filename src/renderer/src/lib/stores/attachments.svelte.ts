import { SvelteMap } from 'svelte/reactivity'
import type { AttachmentKind, AttachmentRefusal } from '@shared/attachments'
import type { AppError } from '@shared/errors'
import type { StageResult } from '@shared/attachments'
import type { Result } from '@shared/errors'
import {
  discardDraft,
  hasPasted,
  newDraft,
  pickFiles,
  removeStaged,
  stageBytes,
  stagePaths,
  type PastedFiles
} from '../attach-input'

export interface DraftAttachment {
  /** Stable in the renderer; `id` is main's id, known once the file is staged. */
  localId: string
  id?: string
  name: string
  kind?: AttachmentKind
  size?: number
  state: 'staging' | 'ready' | 'error'
}

interface Draft {
  items: DraftAttachment[]
  /** Files main refused, for the notices (Slice 4). */
  refused: AttachmentRefusal[]
  /** Staging calls still in flight. */
  pending: number
}

const EMPTY_ITEMS: DraftAttachment[] = []
const EMPTY_REFUSED: AttachmentRefusal[] = []

/** A message box that owns a draft: an open session now, the New Session dialog later. */
export type AttachKey = string

export function sessionKey(sessionId: string): AttachKey {
  return `session:${sessionId}`
}

/**
 * The attachments each message box is composing. A key maps to one draft id, created in main on the
 * first attach; results of a call land in the draft that started it even after the user moved on.
 */
class AttachmentsStore {
  private drafts = $state.raw<Record<string, Draft>>({})
  private draftIds = new SvelteMap<AttachKey, string>()
  private creating = new Map<AttachKey, Promise<string | AppError>>()
  private localCount = 0
  /** Keys abandoned with `discard`: late results for them are cleaned up, not shown. */
  private discarded = new Set<AttachKey>()

  draftIdFor(key: AttachKey): string | null {
    return this.draftIds.get(key) ?? null
  }

  list(key: AttachKey): DraftAttachment[] {
    return this.draftOf(key)?.items ?? EMPTY_ITEMS
  }

  ready(key: AttachKey): DraftAttachment[] {
    return this.list(key).filter((item) => item.state === 'ready')
  }

  refused(key: AttachKey): AttachmentRefusal[] {
    return this.draftOf(key)?.refused ?? EMPTY_REFUSED
  }

  isStaging(key: AttachKey): boolean {
    const draft = this.draftOf(key)
    return !!draft && (draft.pending > 0 || draft.items.some((item) => item.state === 'staging'))
  }

  /** Opens the picker and adds what was chosen. Returns the error when nothing could be staged. */
  async pick(key: AttachKey): Promise<AppError | null> {
    const draftId = await this.ensureDraft(key)
    if (typeof draftId !== 'string') return draftId
    if (this.discarded.has(key)) return null
    this.update(draftId, (draft) => ({
      ...draft,
      pending: draft.pending + 1,
      refused: this.idle(draft) ? [] : draft.refused
    }))
    const res = await pickFiles(draftId)
    if (res.ok && !this.drafts[draftId]) void discardDraft(draftId)
    this.update(draftId, (draft) => ({
      ...draft,
      pending: draft.pending - 1,
      items: res.ok
        ? [...draft.items, ...res.data.attachments.map((meta) => this.ready_(meta))]
        : draft.items,
      refused: res.ok ? [...draft.refused, ...res.data.refused] : draft.refused
    }))
    return res.ok ? null : res.error
  }

  /** Adds dropped or pasted files by path; each shows as a staging chip until main answers. */
  addPaths(key: AttachKey, paths: string[], keepRefused = false): Promise<AppError | null> {
    const placeholders = paths.map((path) => ({ name: path.split(/[\\/]/).pop() || path }))
    return this.stage(key, placeholders, (draftId) => stagePaths(draftId, paths), keepRefused)
  }

  /** Adds one pasted image from its bytes; main names it "Pasted image N". */
  addBytes(
    key: AttachKey,
    bytes: Uint8Array<ArrayBuffer>,
    mime: string,
    keepRefused = false
  ): Promise<AppError | null> {
    return this.stage(
      key,
      [{ name: 'Pasted image', kind: 'image' }],
      (draftId) => stageBytes(draftId, bytes, mime),
      keepRefused
    )
  }

  /** Stages what a paste carried: paths first, then the images one at a time so numbering follows order. */
  async addPasted(key: AttachKey, pasted: PastedFiles): Promise<AppError | null> {
    if (!hasPasted(pasted)) return null
    let failure: AppError | null = null
    // Only the first step of a paste clears the previous notices; the rest add to them.
    let keep = false
    if (pasted.paths.length > 0) {
      failure = await this.addPaths(key, pasted.paths)
      keep = true
    }
    for (const file of pasted.images) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      failure = (await this.addBytes(key, bytes, file.type, keep)) ?? failure
      keep = true
    }
    await this.refuse(
      key,
      pasted.unreadable.map((file) => ({ name: file.name, reason: 'unreadable' as const })),
      keep
    )
    return failure
  }

  /** Records files that could not be staged at all (dropped from a browser, so no path). */
  async refuse(key: AttachKey, refusals: AttachmentRefusal[], keepRefused = false): Promise<void> {
    if (refusals.length === 0) return
    const draftId = await this.ensureDraft(key)
    if (typeof draftId !== 'string') return
    this.update(draftId, (draft) => ({
      ...draft,
      refused: [...(keepRefused || !this.idle(draft) ? draft.refused : []), ...refusals]
    }))
  }

  /** Dismisses the notices at these positions of `refused(key)`. */
  dismissRefused(key: AttachKey, indices: number[]): void {
    const draftId = this.draftIds.get(key)
    if (draftId === undefined) return
    const gone = new Set(indices)
    this.update(draftId, (draft) => ({
      ...draft,
      refused: draft.refused.filter((_, index) => !gone.has(index))
    }))
  }

  /** Forgets the notices only (the user left the message box); the files stay. */
  clearRefused(key: AttachKey): void {
    const draftId = this.draftIds.get(key)
    if (draftId === undefined) return
    this.update(draftId, (draft) =>
      draft.refused.length === 0 ? draft : { ...draft, refused: [] }
    )
  }

  /** Marks the ready attachment with this name as unreadable (the send said so); it is not ready any more. */
  markUnreadable(key: AttachKey, name: string): void {
    const draftId = this.draftIds.get(key)
    if (draftId === undefined) return
    this.update(draftId, (draft) => ({
      ...draft,
      items: draft.items.map((item) =>
        item.name === name && item.state === 'ready' ? { ...item, state: 'error' } : item
      )
    }))
  }

  /** Drops the item at once; main deletes the staged copy in the background. */
  async remove(key: AttachKey, localId: string): Promise<void> {
    const draftId = this.draftIds.get(key)
    const item = this.list(key).find((entry) => entry.localId === localId)
    if (draftId === undefined || !item) return
    this.update(draftId, (draft) => ({
      ...draft,
      items: draft.items.filter((entry) => entry.localId !== localId)
    }))
    if (item.id !== undefined) await removeStaged(draftId, item.id)
  }

  /** Forgets the draft after a send consumed it (main already moved or deleted the files). */
  clear(key: AttachKey): void {
    const draftId = this.draftIds.get(key)
    this.draftIds.delete(key)
    if (draftId === undefined) return
    const rest = { ...this.drafts }
    delete rest[draftId]
    this.drafts = rest
  }

  /**
   * The message box was abandoned (the New Session dialog closed without starting): deletes the
   * staged files and forgets the draft. A draft still being created or a staging call still in
   * flight is cleaned up when it answers.
   */
  async discard(key: AttachKey): Promise<void> {
    if (this.discarded.has(key)) return
    this.discarded.add(key)
    const creating = this.creating.get(key)
    const made = this.draftIds.get(key) ?? (creating ? await creating : undefined)
    this.clear(key)
    if (typeof made === 'string') await discardDraft(made)
  }

  /** Test seam: forgets every draft. */
  reset(): void {
    this.drafts = {}
    this.draftIds.clear()
    this.creating.clear()
    this.discarded.clear()
  }

  private draftOf(key: AttachKey): Draft | undefined {
    const draftId = this.draftIds.get(key)
    return draftId === undefined ? undefined : this.drafts[draftId]
  }

  private async ensureDraft(key: AttachKey): Promise<string | AppError> {
    const known = this.draftIds.get(key)
    if (known !== undefined) return known
    let pending = this.creating.get(key)
    if (!pending) {
      pending = newDraft().then((res) => {
        this.creating.delete(key)
        if (!res.ok) return res.error
        this.draftIds.set(key, res.data.draftId)
        this.drafts = {
          ...this.drafts,
          [res.data.draftId]: { items: [], refused: [], pending: 0 }
        }
        return res.data.draftId
      })
      this.creating.set(key, pending)
    }
    return pending
  }

  private idle(draft: Draft): boolean {
    return draft.pending === 0 && !draft.items.some((item) => item.state === 'staging')
  }

  private async stage(
    key: AttachKey,
    placeholders: { name: string; kind?: AttachmentKind }[],
    call: (draftId: string) => Promise<Result<StageResult>>,
    keepRefused = false
  ): Promise<AppError | null> {
    const draftId = await this.ensureDraft(key)
    if (typeof draftId !== 'string') return draftId
    if (this.discarded.has(key)) return null
    const staging = placeholders.map((p): DraftAttachment => ({
      localId: `local-${++this.localCount}`,
      name: p.name,
      kind: p.kind,
      state: 'staging'
    }))
    this.update(draftId, (draft) => ({
      ...draft,
      items: [...draft.items, ...staging],
      refused: keepRefused || !this.idle(draft) ? draft.refused : []
    }))
    const res = await call(draftId)
    // The box was abandoned while main was copying: delete what it staged meanwhile.
    if (res.ok && !this.drafts[draftId]) void discardDraft(draftId)
    const gone = new Set(staging.map((item) => item.localId))
    this.update(draftId, (draft) => ({
      ...draft,
      items: [
        ...draft.items.filter((item) => !gone.has(item.localId)),
        ...(res.ok ? res.data.attachments.map((meta) => this.ready_(meta)) : [])
      ],
      refused: res.ok ? [...draft.refused, ...res.data.refused] : draft.refused
    }))
    return res.ok ? null : res.error
  }

  private ready_(meta: {
    id: string
    name: string
    kind: AttachmentKind
    size: number
  }): DraftAttachment {
    return {
      localId: `local-${++this.localCount}`,
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      size: meta.size,
      state: 'ready'
    }
  }

  private update(draftId: string, change: (draft: Draft) => Draft): void {
    const draft = this.drafts[draftId]
    if (!draft) return
    this.drafts = { ...this.drafts, [draftId]: change(draft) }
  }
}

export const attachments = new AttachmentsStore()
