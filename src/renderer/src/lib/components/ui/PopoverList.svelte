<script lang="ts">
  interface Props {
    /** The button text, for example "8 more projects". */
    label: string
    /** The accessible name of the opened list. */
    listLabel: string
    items: readonly string[]
    /** Starts open; for the Design Preview only. */
    initiallyOpen?: boolean
  }

  let { label, listLabel, items, initiallyOpen = false }: Props = $props()

  const uid = $props.id()
  const listId = `popover-list-${uid}`

  // svelte-ignore state_referenced_locally
  let open = $state(initiallyOpen)
  let root: HTMLElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()

  function close(): void {
    open = false
    button?.focus()
  }

  function onkeydown(event: KeyboardEvent): void {
    if (open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<div bind:this={root} class="relative shrink-0" role="presentation" {onkeydown} data-popover-list>
  <button
    bind:this={button}
    type="button"
    aria-expanded={open}
    aria-controls={listId}
    onclick={() => (open = !open)}
    class="inline-flex min-h-[var(--size-hit)] items-center rounded-control border border-border px-3 text-xs text-text hover:border-border-strong focus:outline-none focus-visible:shadow-focus"
    >{label}</button
  >
  {#if open}
    <ul
      id={listId}
      aria-label={listLabel}
      class="absolute top-full right-0 z-30 mt-1 max-h-64 min-w-40 overflow-y-auto rounded-control border border-border-strong bg-surface-panel py-1 text-xs text-text"
    >
      {#each items as item (item)}
        <li class="px-3 py-1.5">{item}</li>
      {/each}
    </ul>
  {/if}
</div>
