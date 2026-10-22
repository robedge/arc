<script lang="ts">
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    /** `changed`: edited outside the app while the editor has unsaved text. `deleted`: file removed. */
    kind: 'changed' | 'deleted'
    onprimary: () => void
    onsecondary: () => void
  }

  let { kind, onprimary, onsecondary }: Props = $props()
</script>

<Banner kind="warning">
  <p>
    {#if kind === 'changed'}
      This item changed on disk. Autosave is paused until you choose.
    {:else}
      This item was deleted on disk.
    {/if}
  </p>
  {#snippet actions()}
    {#if kind === 'changed'}
      <Button onclick={onprimary}>Reload</Button>
      <Button variant="primary" onclick={onsecondary}>Keep mine</Button>
    {:else}
      <Button variant="primary" onclick={onprimary}>Save as new</Button>
      <Button onclick={onsecondary}>Close</Button>
    {/if}
  {/snippet}
</Banner>
