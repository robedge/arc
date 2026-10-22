<script lang="ts">
  type Side = 'old' | 'new'
  import type { SplitCell, SplitRow } from '../../review/diff-rows'
  import { anchorKey, splitAnchor, withSplitNotes, type NoteAnchor } from '../../review/note-rows'
  import { SvelteSet } from 'svelte/reactivity'
  import { offsetsOf, rowAt } from '../../review/row-window'
  import { review } from '../../stores/review.svelte'
  import Icon from '../ui/Icon.svelte'
  import NoteSlot from './NoteSlot.svelte'

  interface Props {
    rows: readonly SplitRow[]
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

  let panes: Record<Side, HTMLDivElement | undefined> = $state({ old: undefined, new: undefined })
  let scrollTop = $state(0)
  let viewport = $state(0)
  /** Rendered note heights by notes-row key and pane; a row is as tall as its taller pane. */
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
  const laid = $derived(withSplitNotes(rows, wanted))
  const items = $derived(laid.items)
  const heights = $derived(
    items.map((item) =>
      item.type === 'notes'
        ? Math.max(measured[`${item.key}#old`] ?? 0, measured[`${item.key}#new`] ?? 0) ||
          NOTE_ESTIMATE_PX
        : ROW_HEIGHT_PX
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

  function addNote(anchor: NoteAnchor): void {
    if (noteContext) review.openComposer({ ...noteContext, ...anchor })
  }

  const TONE = { ctx: '', add: 'bg-success/10', del: 'bg-danger/10' } as const
  const SIGN = { ctx: ' ', add: '+', del: '−' } as const

  /** The two panes scroll sideways on their own but share one vertical position. */
  function onscroll(side: Side): void {
    const own = panes[side]
    const other = panes[side === 'old' ? 'new' : 'old']
    if (!own) return
    if (other && other.scrollTop !== own.scrollTop) other.scrollTop = own.scrollTop
    scrollTop = own.scrollTop
    viewport = own.clientHeight
  }

  $effect(() => {
    if (!target) return
    const left = panes.old
    if (!left) return
    left.scrollTop = offsets[laid.indexOf[target.row] ?? target.row] ?? 0
    onscroll('old')
  })
</script>

{#snippet cell(c: SplitCell | null, side: 'old' | 'new')}
  {@const anchor = c && noteContext ? splitAnchor(c, side) : null}
  <div
    class="group flex h-full min-w-0 items-center font-mono text-xs text-text {c
      ? TONE[c.kind]
      : 'bg-surface-code/40'}"
    data-split-cell={side}
    data-diff-line={c?.kind ?? 'empty'}
  >
    {#if noteContext}
      <span class="flex w-6 shrink-0 justify-center">
        {#if anchor}
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center rounded-control text-accent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-focus focus-visible:outline-none"
            aria-label="Add note on line {anchor.line} ({anchor.side})"
            onclick={() => addNote(anchor)}
            data-add-note
          >
            <Icon name="plus" size={14} />
          </button>
        {/if}
      </span>
    {/if}
    <span
      class="w-12 shrink-0 pr-2 text-right text-text-muted select-none"
      aria-hidden="true"
      data-line-no>{c?.no ?? ''}</span
    >
    <span class="w-5 shrink-0 text-center select-none" data-sign>{c ? SIGN[c.kind] : ''}</span>
    <span class="pr-3 whitespace-pre">{c?.text ?? ''}</span>
    {#if c?.noNewline}
      <span class="pr-3 whitespace-pre text-text-muted italic" data-diff-no-newline
        >\ No newline at end of file</span
      >
    {/if}
  </div>
{/snippet}

<!-- A scroll region must be reachable by keyboard so the arrow keys can scroll it. -->
<div class="flex min-h-0 flex-1" data-diff-split>
  {#each ['old', 'new'] as const as side (side)}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      bind:this={panes[side]}
      onscroll={() => onscroll(side)}
      role="region"
      aria-label="{label}, {side === 'old' ? 'before' : 'after'}"
      tabindex="0"
      class="min-h-0 min-w-0 flex-1 overflow-auto focus:outline-none focus-visible:shadow-focus {side ===
      'old'
        ? '[scrollbar-width:none] border-r border-border'
        : ''}"
      data-diff-scroll
      data-diff-pane={side}
    >
      <div class="relative min-w-max" style:height="{total}px">
        <div class="absolute right-0 left-0" style:top="{offsets[first] ?? 0}px">
          {#each visible as row, i (first + i)}
            <div style:height="{heights[first + i]}px" data-diff-row>
              {#if row.type === 'notes'}
                {@const anchor = side === 'old' ? row.left : row.right}
                {#if anchor && noteContext}
                  <NoteSlot
                    {...noteContext}
                    side={anchor.side}
                    line={anchor.line}
                    class="pl-[calc(1.5rem+3rem)]"
                    onheight={(h) => {
                      if (measured[`${row.key}#${side}`] !== h) measured[`${row.key}#${side}`] = h
                    }}
                  />
                {/if}
              {:else if row.type === 'hunk'}
                <div
                  class="flex h-full items-center bg-accent/10 px-3 font-mono text-xs whitespace-pre text-text-muted"
                  data-diff-hunk={side === 'old' ? row.hunkIndex : undefined}
                >
                  {side === 'old' ? row.header : ''}
                </div>
              {:else}
                {@render cell(side === 'old' ? row.left : row.right, side)}
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  {/each}
</div>
