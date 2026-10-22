import type { AppError } from '@shared/errors'
import type { StorageProgressPayload } from '@shared/ipc/contract'
import type {
  StorageLinkChoice,
  StoragePickResult,
  StorageProgressPhase,
  StorageState,
  StorageUnlinkChoice
} from '@shared/types/storage'
import { blockedMessageFor, messageFor } from '../ipc/messages'
import { groupDetail } from './group-detail.svelte'
import { toasts } from './toasts.svelte'
import { ui } from './ui.svelte'

/** A picked folder that passed preflight and is waiting for the user's choice. */
export type PickedFolder = Extract<StoragePickResult, { picked: true }>

export interface StorageProgress {
  phase: StorageProgressPhase
  done: number
  total: number
}

class StorageStore {
  groupId = $state<string | null>(null)
  state = $state<StorageState | null>(null)
  /** The group a link operation is running for, else null. */
  opGroupId = $state<string | null>(null)
  progress = $state<StorageProgress | null>(null)
  /** User-facing failure of the last pick or link, shown in the panel or the dialog. */
  error = $state<string | null>(null)
  /** Set when a folder inside one of the group's projects was linked; shown as a note. */
  repoNote = $state<string | null>(null)
  /** The preflighted folder awaiting a choice in `LinkFolderDialog`. */
  pending = $state<PickedFolder | null>(null)

  /** Monotonic token so a late response for a previous group is ignored. */
  private requestId = 0

  /** The linked folder is missing: the banner shows and section navigation is disabled. */
  get missing(): boolean {
    return this.state !== null && this.state.mode === 'linked' && !this.state.available
  }

  get busy(): boolean {
    return this.opGroupId !== null && this.opGroupId === this.groupId
  }

  async load(groupId: string | null): Promise<void> {
    const request = ++this.requestId
    if (groupId !== this.groupId) {
      this.state = null
      this.progress = null
      this.error = null
      this.repoNote = null
      this.pending = null
    }
    this.groupId = groupId
    if (groupId === null) return
    const res = await window.harness.invoke('storage:get', { groupId })
    if (request !== this.requestId) return
    if (res.ok && res.data) this.state = res.data
  }

  /** Push handler for `storage:progress`. */
  handleProgress(payload: StorageProgressPayload): void {
    if (payload.groupId !== this.groupId) return
    this.progress = { phase: payload.phase, done: payload.done, total: payload.total }
  }

  /** Opens the native picker; links straight away for an empty group, else asks first. */
  async chooseFolder(): Promise<void> {
    const groupId = this.groupId
    if (groupId === null || this.busy) return
    this.error = null
    this.repoNote = null
    const res = await window.harness.invoke('storage:pickFolder', { groupId })
    if (!res.ok) {
      this.error = messageFor(res.error)
      return
    }
    const pick = res.data
    if (!pick.picked) return
    if (pick.blocked !== null || pick.token === null) {
      this.error = blockedMessageFor(pick.blocked ?? 'not-a-folder')
      return
    }
    if (pick.hasKnowledge) {
      this.pending = pick
      ui.openDialog({ kind: 'storage-link' })
      return
    }
    await this.link(pick, 'move')
  }

  /** Runs `storage:link` for a picked folder; returns true on success. */
  async link(pick: PickedFolder, choice: StorageLinkChoice): Promise<boolean> {
    const groupId = this.groupId
    if (groupId === null || pick.token === null) return false
    this.error = null
    this.progress = null
    this.opGroupId = groupId
    try {
      const res = await window.harness.invoke('storage:link', {
        groupId,
        token: pick.token,
        choice
      })
      if (!res.ok) {
        this.error = messageFor(res.error)
        this.opGroupId = null
        this.progress = null
        await this.load(groupId)
        return false
      }
      if (groupId === this.groupId) {
        this.state = res.data
        this.pending = null
        this.repoNote = pick.insideProjectRepo
          ? `This folder is inside the project '${pick.insideProjectRepo.projectName}'. Edits to your knowledge will show up as changes in that repository.`
          : null
        if (ui.dialog?.kind === 'storage-link') ui.closeDialog()
      }
      // The list normally refreshes from `knowledge:changed`; make it explicit too.
      await groupDetail.load(groupId)
      return true
    } finally {
      this.opGroupId = null
      this.progress = null
    }
  }

  /** Push handler for `availability:changed`; only the linked-folder events (no projectId). */
  applyAvailability(event: {
    groupId: string
    projectId?: string
    knowledgeRoot?: boolean
    available: boolean
  }): void {
    if (event.knowledgeRoot !== true || event.groupId !== this.groupId) return
    if (this.state) this.state.available = event.available
    // Pick up hasKnowledge and the rest of the state, which changes with availability.
    void this.load(event.groupId)
  }

  /**
   * Runs one state-changing storage call for the current group. On success the new state is
   * stored and the knowledge lists reload; returns the result, or null on failure (the message
   * is in `error`).
   */
  private async run<T extends StorageState | { state: StorageState }>(
    call: (groupId: string) => Promise<{ ok: true; data: T } | { ok: false; error: AppError }>
  ): Promise<T | null> {
    const groupId = this.groupId
    if (groupId === null || this.busy) return null
    this.error = null
    this.progress = null
    this.repoNote = null
    this.opGroupId = groupId
    try {
      const res = await call(groupId)
      if (!res.ok) {
        this.error = messageFor(res.error)
        await this.load(groupId)
        return null
      }
      if (groupId === this.groupId) {
        this.state = 'state' in res.data ? res.data.state : res.data
      }
      await groupDetail.load(groupId)
      return res.data
    } finally {
      this.opGroupId = null
      this.progress = null
    }
  }

  /** Unlinks the folder; returns true on success. */
  async unlink(choice: StorageUnlinkChoice): Promise<boolean> {
    const done = await this.run((groupId) =>
      window.harness.invoke('storage:unlink', { groupId, choice })
    )
    if (done === null) return false
    if (ui.dialog?.kind === 'storage-unlink') ui.closeDialog()
    return true
  }

  /** Opens the picker to point the group at the moved folder. */
  async locate(): Promise<void> {
    const res = await this.run(async (groupId) => {
      const r = await window.harness.invoke('storage:locate', { groupId })
      if (!r.ok) return r
      // Normalise "cancelled" into the current state so run() leaves things as they are.
      return {
        ok: true as const,
        data: r.data.located
          ? { state: r.data.state, looks: r.data.looksLikeKnowledge, located: true }
          : { state: this.state as StorageState, looks: true, located: false }
      }
    })
    if (res && res.located && !res.looks) {
      toasts.show(
        "That folder doesn't look like this group's knowledge, but it is now linked. Unlink it if that was a mistake.",
        'warning'
      )
    }
  }

  /** Gives up on the missing folder and switches to app storage; returns true on success. */
  async useAppStorage(): Promise<boolean> {
    const done = await this.run((groupId) =>
      window.harness.invoke('storage:useAppStorage', { groupId })
    )
    if (done === null) return false
    if (ui.dialog?.kind === 'storage-use-app') ui.closeDialog()
    return true
  }

  cancelPending(): void {
    if (this.busy) return
    this.pending = null
    this.error = null
    if (ui.dialog?.kind === 'storage-link') ui.closeDialog()
  }
}

export const storage = new StorageStore()
