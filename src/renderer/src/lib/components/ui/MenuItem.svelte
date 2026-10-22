<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    danger?: boolean
    /** When set, the item is a radio: true marks the current choice. */
    selected?: boolean
    onclick: () => void
    children: Snippet
  }

  let { danger = false, selected, onclick, children }: Props = $props()
</script>

<button
  type="button"
  role={selected === undefined ? 'menuitem' : 'menuitemradio'}
  aria-checked={selected}
  {onclick}
  class="flex min-h-[var(--size-hit)] items-center rounded-control px-3 text-left text-sm tracking-label uppercase hover:bg-surface-hover focus:bg-surface-selected focus:outline-none focus-visible:shadow-focus {danger
    ? 'text-danger'
    : 'text-text'}"
>
  {#if selected !== undefined}<span class="w-4 shrink-0" aria-hidden="true"
      >{selected ? '✓' : ''}</span
    >{/if}
  {@render children()}
</button>
