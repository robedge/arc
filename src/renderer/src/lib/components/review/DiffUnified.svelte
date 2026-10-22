<script lang="ts">
  import type { DiffRow } from '../../review/diff-rows'
  import { anchorKey, withUnifiedNotes, type NoteAnchor } from '../../review/note-rows'
  import { SvelteSet } from 'svelte/reactivity'
  import { offsetsOf, rowAt } from '../../review/row-window'
  import { review } from '../../stores/review.svelte'
  import DiffLine from './DiffLine.svelte'
  import NoteSlot from './NoteSlot.svelte'

  interface Props {
    rows: readonly DiffRow[]
    label: string
    /** Scroll this row to the top; `n` changes on every request so the same row can be asked twice. */
    target?: { row: number; n: number } | null
    /** The file the notes belong to; absent for hand edits, which take no notes. */
    noteContext?: { projectId: string; path: string } | null
  }

  let { rows, label, target = null, noteContext = null }: Props = $props()

  /** Diff rows are one height; note rows are measured once shown and estimated until then. */
  const ROW_HEIGHT_PX = 20
  const NOTE_ESTIMATE_PX = 96
  const OVERSCAN_ROWS = 20
  const FALLBACK_VIEWPORT_PX = 480

  let scroller: HTMLDivElement | undefined = $state()
  let scrollTop = $state(0)
  let viewport = $state(0)
  let measured = $state<Record<string, number>>({})

  const wanted = $derived.by(() => {
    const keys = new SvelteSet<string>()
    if (!noteContext) return keys
    for (const n of review.notes) {
      if (n.projectId === noteContext.projectId && n.path === noteContext.path) {
        keys.add(anchorKey(n.side, n.line))
      }
    }
    const c = review.composer
    if (c && c.projectId === noteContext.projectId && c.path === noteContext.path) {
      keys.add(anchorKey(c.side, c.line))
    }
    return keys
  })
  const laid = $derived(withUnifiedNotes(rows, wanted))
  const items = $derived(laid.items)
  const heights = $derived(
    items.map((item) =>
      item.type === 'notes' ? (measured[item.key] ?? NOTE_ESTIMATE_PX) : ROW_HEIGHT_PX
    )
  )
  const offsets = $derived(offsetsOf(heights))
  const total = $derived(offsets[offsets.length - 1] as number)

  const first = $derived(Math.max(0, rowAt(offsets, scrollTop) - OVERSCAN_ROWS))
  const last = $derived(
    Math.min(
      items.length,
      rowAt(offsets, scrollTop + (viewport || FALLBACK_VIEWPORT_PX)) + 1 + OVERSCAN_ROWS
    )
  )
  const visible = $derived(items.slice(first, last))

  function measure(): void {
    if (!scroller) return
    scrollTop = scroller.scrollTop
    viewport = scroller.clientHeight
  }

  function addNote(anchor: NoteAnchor): void {
    if (noteContext) review.openComposer({ ...noteContext, ...anchor })
  }

  $effect(() => {
    if (!target || !scroller) return
    const at = laid.indexOf[target.row] ?? target.row
    scroller.scrollTop = offsets[at] ?? 0
    measure()
  })
</script>

<!-- A scroll region must be reachable by keyboard so the arrow keys can scroll it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={scroller}
  onscroll={measure}
  role="region"
  aria-label={label}
  tabindex="0"
  class="min-h-0 flex-1 overflow-auto focus:outline-none focus-visible:shadow-focus"
  data-diff-scroll
>
  <div class="relative min-w-max" style:height="{total}px">
    <div class="absolute right-0 left-0" style:top="{offsets[first] ?? 0}px">
      {#each visible as item, i (first + i)}
        <div style:height="{heights[first + i]}px" data-diff-row>
          {#if item.type === 'notes' && noteContext}
            <NoteSlot
              {...noteContext}
              side={item.anchor.side}
              line={item.anchor.line}
              class="pl-[calc(8rem+2.25rem)]"
              onheight={(h) => {
                if (measured[item.key] !== h) measured[item.key] = h
              }}
            />
          {:else}
            <DiffLine row={item as DiffRow} onaddnote={noteContext ? addNote : undefined} />
          {/if}
        </div>
      {/each}
    </div>
  </div>
</div>
