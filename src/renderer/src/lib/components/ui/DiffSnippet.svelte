<script lang="ts">
  import type { DiffHunk } from '@shared/types/review'
  import { toUnifiedRows } from '../../review/diff-rows'
  import DiffLine from '../review/DiffLine.svelte'

  interface Props {
    hunks: DiffHunk[]
    /** The region's accessible name, e.g. "Changes to Database schema". */
    label: string
  }

  let { hunks, label }: Props = $props()

  const rows = $derived(toUnifiedRows(hunks))
</script>

<!-- tabindex so keyboard users can scroll the snippet. Not virtualised: a suggestion's diff is short. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  role="region"
  aria-label={label}
  tabindex="0"
  class="max-h-60 overflow-auto rounded-control border border-border bg-surface-code py-1 focus-visible:shadow-focus focus-visible:outline-none"
  data-diff-snippet
>
  {#each rows as row, i (i)}
    {#if row.type === 'hunk'}
      {#if row.hunkIndex > 0}
        <div
          class="px-3 font-mono text-xs leading-4 text-text-muted select-none"
          aria-hidden="true"
          data-diff-separator
        >
          ⋯
        </div>
      {/if}
    {:else}
      <div class="w-max min-w-full">
        <DiffLine {row} compact />
      </div>
    {/if}
  {/each}
</div>
