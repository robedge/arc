<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import type { StorageUnlinkChoice } from '@shared/types/storage'
  import type { StorageProgress } from '../../stores/storage.svelte'
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import Radio from '../ui/Radio.svelte'
  import StorageProgressView from '../settings/StorageProgress.svelte'

  interface Props {
    linkedPath: string
    /** Earlier in-app knowledge was kept aside when the folder was linked. */
    keptAside: boolean
    busy: boolean
    progress: StorageProgress | null
    error: string | null
    onconfirm: (choice: StorageUnlinkChoice) => void
    oncancel: () => void
  }

  let { linkedPath, keptAside, busy, progress, error, onconfirm, oncancel }: Props = $props()

  let choice = $state<StorageUnlinkChoice>('keep-current')

  const OPTIONS: { value: StorageUnlinkChoice; label: string; consequence: string }[] = [
    {
      value: 'keep-current',
      label: 'Keep current knowledge',
      consequence:
        "Copies what is in the folder into the app. The earlier in-app knowledge that was kept aside is discarded and can't be brought back."
    },
    {
      value: 'restore-kept',
      label: 'Restore earlier in-app knowledge',
      consequence:
        'Brings back the knowledge that was kept aside when you linked the folder. What is in the folder is not copied into the app.'
    }
  ]
</script>

<Modal
  title="Unlink folder"
  onsubmit={() => onconfirm(keptAside ? choice : 'keep-current')}
  {oncancel}
  size="lg"
  {busy}
>
  {#if keptAside}
    <p class="text-sm text-text">
      Unlink <span class="font-medium break-all text-text">{linkedPath}</span>? Which knowledge
      should this group keep?
    </p>
    <fieldset class="flex flex-col gap-3" disabled={busy}>
      <legend class="sr-only">Which knowledge to keep</legend>
      {#each OPTIONS as option (option.value)}
        <Radio
          id="unlink-choice-{option.value}"
          name="unlink-choice"
          value={option.value}
          label={option.label}
          description={option.consequence}
          bind:group={choice}
        />
      {/each}
    </fieldset>
  {:else}
    <p class="text-sm text-text">
      Unlink <span class="font-medium break-all text-text">{linkedPath}</span>? Its current
      knowledge is copied into the app, so everything stays visible.
    </p>
  {/if}
  <p class="text-xs text-text-muted">The folder itself and its files are not changed.</p>
  {#if busy}
    <StorageProgressView {progress} />
  {/if}
  {#if error}
    <ErrorText message={error} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={busy}>Unlink folder</Button>
  </div>
</Modal>
