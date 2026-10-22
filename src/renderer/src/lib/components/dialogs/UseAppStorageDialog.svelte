<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import type { StorageProgress } from '../../stores/storage.svelte'
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import StorageProgressView from '../settings/StorageProgress.svelte'

  interface Props {
    /** Earlier in-app knowledge was kept aside and will be restored. */
    keptAside: boolean
    busy: boolean
    progress: StorageProgress | null
    error: string | null
    onconfirm: () => void
    oncancel: () => void
  }

  let { keptAside, busy, progress, error, onconfirm, oncancel }: Props = $props()
</script>

<Modal title="Use app storage" onsubmit={onconfirm} {oncancel} size="sm" {busy}>
  {#if keptAside}
    <p class="text-sm text-text">
      The earlier in-app knowledge that was kept aside when you linked the folder will be restored.
    </p>
  {:else}
    <p class="text-sm text-text">
      Nothing was kept aside, so this group will start with empty knowledge in the app. Nothing can
      be copied from the missing folder.
    </p>
  {/if}
  <p class="text-xs text-text-muted">
    The folder's files are not touched. If you find it later, you can link it again.
  </p>
  {#if busy}
    <StorageProgressView {progress} />
  {/if}
  {#if error}
    <ErrorText message={error} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={busy}>Use app storage</Button>
  </div>
</Modal>
