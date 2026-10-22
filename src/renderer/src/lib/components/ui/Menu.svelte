<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    label: string
    /** Placement classes, e.g. "right-0". */
    class?: string
    onkeydown?: (event: KeyboardEvent) => void
    children: Snippet
  }

  let { label, class: className = '', onkeydown, children }: Props = $props()

  function focusFirst(node: HTMLElement): void {
    node.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }
</script>

<div
  role="menu"
  tabindex="-1"
  aria-label={label}
  {onkeydown}
  use:focusFirst
  class="absolute top-full z-10 mt-1 flex w-44 flex-col rounded-hud border border-border-strong bg-surface-raised p-1 shadow-glow-accent {className}"
>
  {@render children()}
</div>
