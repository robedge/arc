<script lang="ts">
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'

  interface Props {
    linkedPath: string | null
    busy: boolean
    error: string | null
    onlocate: () => void
    onuseapp: () => void
  }

  let { linkedPath, busy, error, onlocate, onuseapp }: Props = $props()
</script>

<Banner kind="warning" title="Knowledge folder not found" class="mt-3">
  {#if linkedPath}
    <p class="truncate text-xs text-attention" title={linkedPath}>{linkedPath}</p>
  {/if}
  {#if error}
    <ErrorText class="mt-1" message={error} />
  {/if}
  {#snippet actions()}
    <Button disabled={busy} onclick={onlocate}>Locate…</Button>
    <Button variant="primary" disabled={busy} onclick={onuseapp}>Use app storage</Button>
  {/snippet}
</Banner>
