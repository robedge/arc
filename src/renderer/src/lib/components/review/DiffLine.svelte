<script lang="ts">
  import Icon from '../ui/Icon.svelte'
  import type { DiffRow } from '../../review/diff-rows'
  import { unifiedAnchor, type NoteAnchor } from '../../review/note-rows'

  interface Props {
    row: DiffRow
    /** Shows the "Add note" gutter button; absent where notes are not allowed (hand edits). */
    onaddnote?: (anchor: NoteAnchor) => void
  }

  let { row, onaddnote }: Props = $props()

  const anchor = $derived(row.type === 'line' ? unifiedAnchor(row) : null)

  // Removed and added lines are tinted backgrounds with normal text; the sign column carries the meaning too.
  const TONE = { ctx: '', add: 'bg-success/10', del: 'bg-danger/10' } as const
  const SIGN = { ctx: ' ', add: '+', del: '−' } as const
</script>

{#if row.type === 'hunk'}
  <div
    class="flex h-full items-center bg-accent/10 px-3 font-mono text-xs whitespace-pre text-text-muted"
    data-diff-hunk={row.hunkIndex}
  >
    {row.header}
  </div>
{:else if row.type === 'noNewline'}
  <div
    class="flex h-full items-center {onaddnote
      ? 'pl-[calc(8rem+2.25rem)]'
      : 'pl-[calc(8rem+0.75rem)]'} font-mono text-xs whitespace-pre text-text-muted italic"
    data-diff-no-newline
  >
    \ No newline at end of file
  </div>
{:else}
  <div
    class="group flex h-full items-center font-mono text-xs text-text {TONE[row.kind]}"
    data-diff-line={row.kind}
  >
    {#if onaddnote}
      <span class="flex w-6 shrink-0 justify-center">
        {#if anchor}
          <button
            type="button"
            class="flex h-5 w-5 items-center justify-center rounded-control text-accent opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:shadow-focus focus-visible:outline-none"
            aria-label="Add note on line {anchor.line} ({anchor.side})"
            onclick={() => onaddnote(anchor)}
            data-add-note
          >
            <Icon name="plus" size={14} />
          </button>
        {/if}
      </span>
    {/if}
    <span
      class="w-16 shrink-0 pr-2 text-right text-text-muted select-none"
      aria-hidden="true"
      data-old-no>{row.oldNo ?? ''}</span
    >
    <span
      class="w-16 shrink-0 pr-2 text-right text-text-muted select-none"
      aria-hidden="true"
      data-new-no>{row.newNo ?? ''}</span
    >
    <span class="w-5 shrink-0 text-center select-none" data-sign>{SIGN[row.kind]}</span>
    <span class="pr-3 whitespace-pre">{row.text}</span>
  </div>
{/if}
