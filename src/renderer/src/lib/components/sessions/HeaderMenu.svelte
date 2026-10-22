<script lang="ts">
  import Menu from '../ui/Menu.svelte'
  import MenuItem from '../ui/MenuItem.svelte'

  import { isGroup, type PickerEntry } from '../../model-options'

  interface Props {
    /** Button text, e.g. "Brain · Sonnet". */
    text: string
    /** Accessible name of the menu, e.g. "Brain model". */
    label: string
    /** Options, or labelled groups of options (rendered as `role="group"`). */
    options: readonly PickerEntry[]
    /** Value of the current option, marked as selected. */
    current: string | readonly string[]
    onselect: (value: string) => void
  }

  let { text, label, options, current, onselect }: Props = $props()

  let open = $state(false)
  let root: HTMLElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()

  function close(): void {
    open = false
    button?.focus()
  }

  function choose(value: string): void {
    close()
    onselect(value)
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    const items = [...(root?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items.at(event.key === 'Home' ? 0 : -1)?.focus()
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      typeAhead(event.key, items)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = (event.key === 'ArrowDown' ? index + 1 : index - 1 + items.length) % items.length
    items.at(next)?.focus()
  }

  // Typing jumps to the next item whose text starts with what was typed; the buffer clears after a pause.
  const TYPE_AHEAD_MS = 700
  let typed = ''
  let typedAt = 0

  function typeAhead(key: string, items: HTMLElement[]): void {
    const now = Date.now()
    typed = now - typedAt > TYPE_AHEAD_MS ? key : typed + key
    typedAt = now
    const text = (el: HTMLElement): string =>
      (el.textContent ?? '').replace('✓', '').trim().toLowerCase()
    const start = items.indexOf(document.activeElement as HTMLElement)
    // A single repeated key cycles; a longer prefix searches from the focused item.
    const from = typed.length === 1 ? start + 1 : Math.max(start, 0)
    const ordered = [...items.slice(from), ...items.slice(0, from)]
    const hit = ordered.find((el) => text(el).startsWith(typed.toLowerCase()))
    hit?.focus()
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<div bind:this={root} class="relative shrink-0">
  <button
    bind:this={button}
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label={label}
    onclick={() => (open = !open)}
    class="inline-flex min-h-[var(--size-hit)] items-center rounded-control border border-border px-3 text-xs tracking-label text-text-muted uppercase hover:border-border-strong focus:outline-none focus-visible:shadow-focus"
    >{text}</button
  >
  {#if open}
    <Menu {label} class="right-0 max-h-80 overflow-y-auto" {onkeydown}>
      {#each options as entry (isGroup(entry) ? `group:${entry.group}` : entry.value)}
        {#if isGroup(entry)}
          <div role="group" aria-label={entry.group} class="flex flex-col">
            <span
              aria-hidden="true"
              class="px-3 pt-2 pb-1 text-xs tracking-label text-text-muted uppercase"
              >{entry.group}</span
            >
            {#each entry.options as option (option.value)}
              <MenuItem
                selected={[current].flat().includes(option.value)}
                onclick={() => choose(option.value)}>{option.label}</MenuItem
              >
            {/each}
          </div>
        {:else}
          <MenuItem
            selected={[current].flat().includes(entry.value)}
            onclick={() => choose(entry.value)}>{entry.label}</MenuItem
          >
        {/if}
      {/each}
    </Menu>
  {/if}
</div>
