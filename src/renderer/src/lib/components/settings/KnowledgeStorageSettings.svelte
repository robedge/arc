<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import { revealInFinder } from '../../reveal'
  import { ui } from '../../stores/ui.svelte'
  import { storage } from '../../stores/storage.svelte'
  import Button from '../ui/Button.svelte'
  import Icon from '../ui/Icon.svelte'
  import StorageProgress from './StorageProgress.svelte'

  interface Props {
    groupId: string
  }

  let { groupId }: Props = $props()

  let busy = $derived(storage.busy)
  let state = $derived(storage.state)
</script>

<section aria-label="Knowledge storage" class="flex flex-col gap-2">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <p class="text-[13px] tracking-label text-text-muted uppercase">Knowledge storage</p>
      {#if state === null}
        <p class="text-sm text-text-muted">Loading…</p>
      {:else if state.mode === 'linked' && state.linkedPath}
        <p class="truncate font-mono text-sm text-text" title={state.linkedPath}>
          {state.linkedPath}
        </p>
      {:else}
        <p class="text-sm text-text">Stored in app</p>
      {/if}
    </div>
    <div class="flex gap-2">
      {#if state?.mode === 'linked' && state.available}
        <Button
          disabled={busy}
          onclick={() => {
            storage.error = null
            ui.openDialog({ kind: 'storage-unlink' })
          }}>Unlink folder</Button
        >
      {/if}
      {#if state?.mode === 'app'}
        <Button disabled={busy} onclick={() => void storage.chooseFolder()}>Link folder…</Button>
      {/if}
      <Button disabled={busy} onclick={() => void revealInFinder({ groupId })}>
        Show in Finder
      </Button>
    </div>
  </div>
  {#if state?.keptAside}
    <p class="text-xs text-text-muted">
      Earlier in-app knowledge is kept aside and can be restored when the folder is unlinked.
    </p>
  {/if}
  {#if busy && !ui.dialog?.kind.startsWith('storage-')}
    <StorageProgress progress={storage.progress} />
  {/if}
  {#if storage.error && !storage.missing && !ui.dialog?.kind.startsWith('storage-')}
    <ErrorText message={storage.error} />
  {/if}
  {#if storage.repoNote}
    <p class="flex items-start gap-1.5 text-xs text-attention">
      <Icon name="warning" size={14} class="mt-0.5" /><span>{storage.repoNote}</span>
    </p>
  {/if}
</section>
