<script lang="ts">
  import { cutText } from '@shared/surface'
  import Button from '../../ui/Button.svelte'

  interface Props {
    text: string
    /** Longer text is cut here until the reader asks for all of it. */
    maxLines?: number
    maxChars?: number
  }

  let { text, maxLines = Infinity, maxChars = Infinity }: Props = $props()

  const cut = $derived(cutText(text, maxLines, maxChars))
  let expanded = $state(false)
  const shown = $derived(cut === null || expanded ? text : cut)
</script>

<div class="flex min-w-0 flex-col gap-1">
  <pre
    class="m-0 overflow-x-auto rounded-control border border-border bg-surface-code p-3 font-mono text-sm break-words whitespace-pre-wrap text-text"
    data-code>{shown}</pre>
  {#if cut !== null}
    <div>
      <Button
        ariaLabel={expanded ? 'Show less' : 'Show more'}
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </Button>
    </div>
  {/if}
</div>
