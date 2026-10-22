<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import Icon from '../ui/Icon.svelte'
  import type { StorageLinkChoice } from '@shared/types/storage'
  import type { PickedFolder, StorageProgress } from '../../stores/storage.svelte'
  import Modal from '../ui/Modal.svelte'
  import Button from '../ui/Button.svelte'
  import Radio from '../ui/Radio.svelte'
  import StorageProgressView from '../settings/StorageProgress.svelte'

  interface Props {
    pick: PickedFolder
    busy: boolean
    progress: StorageProgress | null
    error: string | null
    onchoose: (choice: StorageLinkChoice) => void
    oncancel: () => void
  }

  let { pick, busy, progress, error, onchoose, oncancel }: Props = $props()

  let choice = $state<StorageLinkChoice>('move')

  const OPTIONS: { value: StorageLinkChoice; label: string; consequence: string }[] = [
    {
      value: 'move',
      label: 'Move existing knowledge here',
      consequence:
        'Your knowledge is moved into the folder and merged with what is there; files with the same name are kept side by side, so nothing is overwritten.'
    },
    {
      value: 'folder-only',
      label: "Use the folder's contents only",
      consequence:
        'The group shows only what is in the folder; your current in-app knowledge is kept aside and offered back if you unlink.'
    }
  ]
</script>

<Modal title="Link folder" onsubmit={() => onchoose(choice)} {oncancel} size="lg" {busy}>
  <p class="text-sm text-text">
    This group already has knowledge. How should it work with
    <span class="font-medium break-all text-text">{pick.path}</span>?
  </p>
  <fieldset class="flex flex-col gap-3" disabled={busy}>
    <legend class="sr-only">What to do with existing knowledge</legend>
    {#each OPTIONS as option (option.value)}
      <Radio
        id="link-choice-{option.value}"
        name="link-choice"
        value={option.value}
        label={option.label}
        description={option.consequence}
        bind:group={choice}
      />
    {/each}
  </fieldset>
  {#if pick.insideProjectRepo}
    <p role="note" class="flex items-start gap-1.5 text-xs text-attention">
      <Icon name="warning" size={14} class="mt-0.5" />
      <span>
        This folder is inside the project '{pick.insideProjectRepo.projectName}'. Edits to your
        knowledge will show up as changes in that repository.
      </span>
    </p>
  {/if}
  {#if busy}
    <StorageProgressView {progress} />
  {/if}
  {#if error}
    <ErrorText message={error} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={busy}>Link folder</Button>
  </div>
</Modal>
