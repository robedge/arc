<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { TerminalBuffer } from '../../stores/worker-terminals.svelte'
  import { isHelperLine } from './worker-status'
  import { rowOffsets, rowsInWindow } from './terminal-wrap'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'

  interface Props {
    buffer: TerminalBuffer
    label: string
  }

  let { buffer, label }: Props = $props()

  /** Fixed row height: the window is computed from it, so long output never grows the DOM. */
  const LINE_HEIGHT_PX = 18
  const OVERSCAN_LINES = 20
  const FALLBACK_VIEWPORT_PX = 480
  const STICK_THRESHOLD_PX = 24
  const PROBE_CHARS = 100
  const MIN_COLS = 8
  /** Widest horizontal padding of a row (helper lines: pl-6 + pr-3). */
  const ROW_PADDING_PX = 36

  let scroller: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let viewport = $state(0)
  let stuck = $state(true)
  /** Columns that fit the scroller; Infinity until it is measured (no layout, no wrapping). */
  let cols = $state(Infinity)

  const offsets = $derived.by(() => {
    void buffer.version
    return rowOffsets(buffer.lines, cols)
  })
  const count = $derived(offsets[offsets.length - 1] ?? 0)
  const first = $derived(Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - OVERSCAN_LINES))
  const last = $derived(
    Math.min(
      count,
      Math.ceil((scrollTop + (viewport || FALLBACK_VIEWPORT_PX)) / LINE_HEIGHT_PX) + OVERSCAN_LINES
    )
  )
  const visible = $derived.by(() => {
    void buffer.version
    return rowsInWindow(buffer.lines, offsets, cols, first, last)
  })

  /** Width of one monospace character, measured with a probe in the scroller's own font. */
  function charWidth(el: HTMLElement): number {
    const probe = document.createElement('span')
    probe.textContent = 'M'.repeat(PROBE_CHARS)
    probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;pointer-events:none'
    el.appendChild(probe)
    const width = probe.getBoundingClientRect().width / PROBE_CHARS
    probe.remove()
    return width
  }

  function measureCols(): void {
    if (!scroller) return
    const width = charWidth(scroller)
    const inner = scroller.clientWidth - ROW_PADDING_PX
    cols = width > 0 && inner > 0 ? Math.max(MIN_COLS, Math.floor(inner / width)) : Infinity
  }

  $effect(() => {
    if (!scroller || typeof ResizeObserver === 'undefined') return
    measureCols()
    const observer = new ResizeObserver(() => {
      // Re-wrapping changes the content height without the user scrolling: keep following the tail if we were.
      const wasStuck = stuck
      measureCols()
      if (wasStuck) void tick().then(toBottom)
      else measure()
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  })

  function measure(): void {
    if (!scroller) return
    scrollTop = scroller.scrollTop
    viewport = scroller.clientHeight
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX
  }

  function toBottom(): void {
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    scrollTop = scroller.scrollTop
    viewport = scroller.clientHeight
    stuck = true
  }

  $effect(() => {
    void buffer.version
    void count
    if (untrack(() => stuck)) void tick().then(toBottom)
  })
</script>

<div class="relative flex min-h-0 min-w-0 flex-1 flex-col" data-terminal>
  {#if buffer.truncated}
    <p class="shrink-0 px-3 py-1 text-xs text-text-muted" data-terminal-trimmed>
      Earlier output trimmed
    </p>
  {/if}
  {#if buffer.error}
    <div class="p-3"><ErrorText message={buffer.error} /></div>
  {:else if !buffer.ready}
    <p class="p-3 text-sm text-text-muted" role="status">Loading output</p>
  {/if}
  <!-- A scroll region must be reachable by keyboard so the arrow keys can scroll it. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={scroller}
    onscroll={measure}
    role="log"
    aria-live="off"
    aria-label={label}
    tabindex="0"
    class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto font-mono text-xs text-text focus:outline-none focus-visible:shadow-focus"
    data-terminal-log
  >
    <div class="relative" style:height="{count * LINE_HEIGHT_PX}px">
      <div class="absolute right-0 left-0" style:top="{first * LINE_HEIGHT_PX}px">
        {#each visible as row, i (first + i)}
          {@const helper = isHelperLine(buffer.lines[row.line] ?? '')}
          <div
            class={helper ? 'pr-3 pl-6 text-text-muted opacity-75' : 'px-3'}
            data-helper-line={helper ? '' : undefined}
            data-terminal-wrapped={row.continuation ? '' : undefined}
            style:height="{LINE_HEIGHT_PX}px"
            style:line-height="{LINE_HEIGHT_PX}px"
            data-terminal-line
          >
            <span class="whitespace-pre">{row.text}</span>
          </div>
        {/each}
      </div>
    </div>
  </div>
  {#if !stuck}
    <div class="pointer-events-none absolute right-4 bottom-2 left-4 flex justify-center">
      <span class="pointer-events-auto"><Button onclick={toBottom}>Jump to latest</Button></span>
    </div>
  {/if}
</div>
