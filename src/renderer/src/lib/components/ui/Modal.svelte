<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Snippet } from 'svelte'
  import Panel from './Panel.svelte'

  interface Props {
    title: string
    onsubmit: () => void
    oncancel: () => void
    children: Snippet
    size?: 'sm' | 'md' | 'lg'
    /** While busy, Escape is ignored. */
    busy?: boolean
    /** When false, Escape never cancels. */
    closeable?: boolean
  }

  let {
    title,
    onsubmit,
    oncancel,
    children,
    size = 'md',
    busy = false,
    closeable = true
  }: Props = $props()

  const WIDTHS = { sm: 'w-80', md: 'w-96', lg: 'w-[32rem]' } as const

  const titleId = `modal-title-${Math.random().toString(36).slice(2)}`
  let panel: HTMLDivElement | undefined = $state()
  let previouslyFocused: Element | null = null

  const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), select, textarea, [href], [tabindex]:not([tabindex="-1"])'

  onMount(() => {
    previouslyFocused = document.activeElement
    const first = panel?.querySelector<HTMLElement>('input, ' + FOCUSABLE)
    first?.focus()
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    }
  })

  // A control that disables itself while busy (e.g. the export button) drops focus to <body>;
  // pull it back onto the dialog so Tab and Escape keep being handled here.
  $effect(() => {
    void busy
    void tick().then(() => {
      if (panel && !panel.contains(document.activeElement)) panel.focus()
    })
  })

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (!busy && closeable) oncancel()
      return
    }
    if (event.key !== 'Tab' || !panel) return
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items.at(-1)
    if (!first || !last) {
      // Nothing focusable (every control disabled): keep focus parked on the dialog.
      event.preventDefault()
      panel.focus()
      return
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  function handleSubmit(event: SubmitEvent): void {
    event.preventDefault()
    onsubmit()
  }
</script>

<div
  class="no-drag fixed inset-0 z-10 flex items-center justify-center bg-surface-scrim backdrop-blur-sm"
  data-modal-scrim
>
  <div
    bind:this={panel}
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    {onkeydown}
    class="modal-draw max-w-[calc(100vw-2rem)] {WIDTHS[size]}"
    data-size={size}
  >
    <Panel as="div" class="shadow-xl">
      <form onsubmit={handleSubmit} class="flex flex-col gap-4 p-5" novalidate>
        <h2
          id={titleId}
          class="font-display text-lg font-semibold tracking-title text-text uppercase"
        >
          {title}
        </h2>
        {@render children()}
      </form>
    </Panel>
  </div>
</div>

<style>
  /* Entrance is CSS only: it never sets pointer-events or inert, and focus is already set on mount. */
  .modal-draw {
    animation: modal-draw var(--duration-draw) var(--ease-hud) both;
  }
  .modal-draw :global(.hud-bracket) {
    animation: modal-bracket var(--duration-draw) var(--ease-hud) both;
  }
  [data-modal-scrim] {
    animation: modal-scrim var(--duration-draw) var(--ease-hud) both;
  }
  :global(:root[data-motion='reduced']) .modal-draw,
  :global(:root[data-motion='reduced']) .modal-draw :global(.hud-bracket),
  :global(:root[data-motion='reduced']) [data-modal-scrim] {
    animation: none;
  }
  @keyframes modal-draw {
    from {
      opacity: 0;
      transform: scale(0.98);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes modal-bracket {
    from {
      opacity: 0;
      transform: scale(0.4);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
  @keyframes modal-scrim {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
