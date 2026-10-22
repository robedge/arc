<script lang="ts">
  import { usage } from '../../stores/usage.svelte'
  import { sessionTotalGap } from '../../usage/derive'
  import LiveMark from '../ui/LiveMark.svelte'
  import TokenCount from '../ui/TokenCount.svelte'
  import UsagePanel from './UsagePanel.svelte'

  interface Props {
    sessionId: string
  }

  let { sessionId }: Props = $props()

  const total = $derived(usage.totalFor(sessionId))
  const snapshot = $derived(usage.bySession[sessionId] ?? null)
  const gap = $derived(sessionTotalGap(snapshot))
  const inProgress = $derived(snapshot?.agents.some((a) => a.inFlight !== undefined) ?? false)
  const panelId = $derived(`usage-panel-${sessionId}`)

  let open = $state(false)
  let root: HTMLElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()
  /** Anchor the panel to the chip's right edge when the chip sits in the right half. */
  let alignRight = $state(false)
  /** Space between the chip's bottom edge and the window's bottom edge, minus a margin. */
  let maxHeight: number | undefined = $state()

  function toggle(): void {
    if (!open && button) {
      const rect = button.getBoundingClientRect()
      alignRight = rect.left > window.innerWidth / 2
      maxHeight = window.innerHeight - rect.bottom - 16
    }
    open = !open
  }

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

<div bind:this={root} class="relative shrink-0" role="presentation" {onkeydown}>
  <button
    bind:this={button}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={panelId}
    onclick={toggle}
    class="inline-flex min-h-[var(--size-hit)] items-center gap-1.5 rounded-control border border-border px-3 text-xs tracking-label text-text-muted uppercase hover:border-border-strong focus:outline-none focus-visible:shadow-focus"
    data-usage-chip
    ><span>Tokens ·</span>{#if inProgress}<LiveMark />{/if}<TokenCount
      value={gap ? null : (total ?? 0)}
      notReported={gap === 'not-reported'}
      class="text-text"
    /></button
  >
  {#if open}
    <UsagePanel id={panelId} {snapshot} {maxHeight} class={alignRight ? 'right-0' : 'left-0'} />
  {/if}
</div>
