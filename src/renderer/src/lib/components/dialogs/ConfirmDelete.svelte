<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import Icon from '../ui/Icon.svelte'
  import type { AppError } from '@shared/errors'
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import StorageProgress from '../settings/StorageProgress.svelte'
  import type { StorageProgress as Progress } from '../../stores/storage.svelte'
  import { blockedMessageFor, messageFor } from '../../ipc/messages'

  export type DeleteTarget =
    | { kind: 'group'; name: string; groupId?: string }
    | { kind: 'section'; name: string; itemCount: number }
    | { kind: 'project'; name: string }
    | { kind: 'item'; name: string }

  interface Props {
    target: DeleteTarget
    /** Returns an AppError (shown inline) or null on success. */
    submit: () => Promise<AppError | null>
    formatError: (error: AppError) => string
    onclose: () => void
  }

  let { target, submit, formatError, onclose }: Props = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)
  let exporting = $state(false)
  let exportProgress = $state<Progress | null>(null)
  let exportNote = $state<string | null>(null)
  /** Where the group's knowledge lives; null until known (the export button waits for it). */
  let storageMode = $state<'app' | 'linked' | null>(null)
  const groupId = $derived(target.kind === 'group' ? (target.groupId ?? null) : null)
  const locked = $derived(busy || exporting)

  $effect(() => {
    const id = groupId
    if (id === null) return
    let stale = false
    void window.harness.invoke('storage:get', { groupId: id }).then((res) => {
      if (!stale && res.ok && res.data) storageMode = res.data.mode
    })
    const off = window.harness.on('storage:progress', (e) => {
      if (e.groupId === id) exportProgress = { phase: e.phase, done: e.done, total: e.total }
    })
    return () => {
      stale = true
      off()
    }
  })

  async function exportFirst(): Promise<void> {
    const id = groupId
    if (id === null || locked) return
    error = null
    exportNote = null
    exporting = true
    exportProgress = null
    try {
      const pick = await window.harness.invoke('storage:pickExportFolder', { groupId: id })
      if (!pick.ok) {
        error = messageFor(pick.error)
        return
      }
      if (!pick.data.picked) return
      if (pick.data.blocked !== null || pick.data.token === null) {
        error = blockedMessageFor(pick.data.blocked ?? 'not-a-folder')
        return
      }
      const res = await window.harness.invoke('storage:export', {
        groupId: id,
        token: pick.data.token
      })
      if (!res.ok) {
        error = messageFor(res.error)
        return
      }
      const { count, path } = res.data
      exportNote = `Exported ${count} ${count === 1 ? 'file' : 'files'} to ${path}`
    } finally {
      exporting = false
      exportProgress = null
    }
  }

  const copy = $derived(
    target.kind === 'group'
      ? {
          title: 'Delete Group',
          noun: 'group',
          reassurance: 'Your project folders will not be touched.'
        }
      : target.kind === 'project'
        ? { title: 'Remove Project' }
        : target.kind === 'item'
          ? { title: 'Delete Item' }
          : { title: 'Delete Section' }
  )
  const confirmText = $derived(target.kind === 'project' ? 'Remove' : 'Delete')

  async function onsubmit(): Promise<void> {
    if (locked) return
    busy = true
    try {
      const failure = await submit()
      if (failure) error = formatError(failure)
      else onclose()
    } finally {
      busy = false
    }
  }
</script>

<Modal title={copy.title} {onsubmit} oncancel={onclose} size="sm" busy={locked}>
  {#if target.kind === 'group' && 'noun' in copy}
    <p class="text-sm text-text">
      Delete the {copy.noun} <strong class="text-text">{target.name}</strong>?
      {#if storageMode === 'linked'}
        Your linked knowledge folder will not be deleted.
      {:else}
        Knowledge stored in the app for it will be deleted.
      {/if}
      {copy.reassurance}
    </p>
    {#if storageMode === 'app'}
      <div>
        <Button onclick={() => void exportFirst()} disabled={locked}>Export knowledge first</Button>
      </div>
    {/if}
    {#if exporting}
      <StorageProgress progress={exportProgress} />
    {/if}
    {#if exportNote}
      <p role="status" class="flex items-start gap-1.5 text-sm break-all text-success">
        <Icon name="success" size={16} class="mt-0.5" /><span>{exportNote}</span>
      </p>
    {/if}
  {:else if target.kind === 'project'}
    <p class="text-sm text-text">
      Remove '{target.name}' from this group? The folder on disk won't be changed.
    </p>
  {:else if target.kind === 'item'}
    <p class="text-sm text-text">Delete '{target.name}'?</p>
  {:else if target.kind === 'section'}
    <p class="text-sm text-text">
      {target.itemCount > 0
        ? `Delete '${target.name}' and its ${target.itemCount} items?`
        : `Delete '${target.name}'?`}
    </p>
  {/if}
  {#if error}
    <ErrorText message={error} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button onclick={onclose} disabled={exporting}>Cancel</Button>
    <Button type="submit" variant="danger" disabled={locked}>{confirmText}</Button>
  </div>
</Modal>
