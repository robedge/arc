<script lang="ts">
  import type { ReviewNoteSide } from '@shared/types/review'
  import { anchorKey } from '../../review/note-rows'
  import { review } from '../../stores/review.svelte'
  import NoteComposer from './NoteComposer.svelte'
  import NoteThread from './NoteThread.svelte'

  interface Props {
    projectId: string
    path: string
    side: ReviewNoteSide
    line: number
    /** Reports the rendered height so the diff window can place the rows below. */
    onheight?: (height: number) => void
    class?: string
  }

  let { projectId, path, side, line, onheight, class: className = '' }: Props = $props()

  const notes = $derived(
    review.notes.filter(
      (n) => n.projectId === projectId && n.path === path && n.side === side && n.line === line
    )
  )
  const composing = $derived(
    review.composer !== null &&
      review.composer.projectId === projectId &&
      review.composer.path === path &&
      anchorKey(review.composer.side, review.composer.line) === anchorKey(side, line)
  )
  let box: HTMLDivElement | undefined = $state()

  // Reports the rendered height whenever it changes (a composer opening, a note edited).
  $effect(() => {
    if (!box || typeof ResizeObserver === 'undefined') return
    const el = box
    const report = (): void => {
      if (el.offsetHeight > 0) onheight?.(el.offsetHeight)
    }
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  })
</script>

<div class="py-1 pr-3 {className}" bind:this={box} data-note-slot="{side}:{line}">
  <div class="flex w-[36rem] max-w-full flex-col gap-2 font-sans">
    {#if notes.length > 0}
      <NoteThread {notes} />
    {/if}
    {#if composing}
      <NoteComposer
        id="note-composer-{side}-{line}"
        label="Note on line {line} ({side})"
        onsave={(body) => review.createNote(body)}
        oncancel={() => review.closeComposer()}
      />
    {/if}
  </div>
</div>
