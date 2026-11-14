<script lang="ts">
  import { cutText } from '@shared/surface'
  import Button from '../../ui/Button.svelte'

  interface Props {
    text: string
    /** Tailwind classes for the paragraph. */
    textClass: string
    maxLines?: number
  }

  let { text, textClass, maxLines }: Props = $props()

  const cut = $derived(maxLines === undefined ? null : cutText(text, maxLines, Infinity))
  let expanded = $state(false)
</script>

<div class="flex min-w-0 flex-col items-start gap-1">
  <p class="[overflow-wrap:anywhere] whitespace-pre-wrap {textClass}">
    {cut === null || expanded ? text : cut}
  </p>
  {#if cut !== null}
    <Button ariaLabel={expanded ? 'Show less' : 'Show more'} onclick={() => (expanded = !expanded)}>
      {expanded ? 'Show less' : 'Show more'}
    </Button>
  {/if}
</div>
