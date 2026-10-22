<script lang="ts">
  import type { DraftStatus } from '../../stores/item-draft.svelte'
  import Icon from './Icon.svelte'

  let { status }: { status: DraftStatus } = $props()
  const label = $derived(
    status === 'saving'
      ? 'Saving…'
      : status === 'saved'
        ? 'Saved'
        : status === 'error'
          ? "Couldn't save"
          : ''
  )
</script>

<span
  role="status"
  data-state={status}
  class="inline-flex items-center gap-1 text-xs {status === 'error'
    ? 'text-danger'
    : status === 'saved'
      ? 'text-success'
      : 'text-text-muted'}"
>
  {#if status === 'saved'}<Icon name="check" size={14} />{:else if status === 'error'}<Icon
      name="error"
      size={14}
    />{/if}
  {label}
</span>
