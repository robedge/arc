<script lang="ts">
  import type { ReviewNote } from '@shared/types/review'
  import { messageFor } from '../../ipc/messages'
  import { review } from '../../stores/review.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import NoteComposer from './NoteComposer.svelte'

  interface Props {
    notes: readonly ReviewNote[]
    /** Names each note's line; for notes that are not shown under their line. */
    showLine?: boolean
  }

  let { notes, showLine = false }: Props = $props()

  let editing = $state<string | null>(null)

  async function remove(note: ReviewNote): Promise<void> {
    const error = await review.deleteNote(note.id)
    if (error) toasts.show(messageFor(error), 'error')
  }
</script>

<ul class="m-0 flex list-none flex-col gap-2 p-0" data-note-thread>
  {#each notes as note (note.id)}
    <li
      class="rounded-control border border-border-strong bg-surface-panel p-2 text-sm text-text"
      data-note={note.state}
    >
      {#if editing === note.id}
        <NoteComposer
          id="note-edit-{note.id}"
          label="Edit note on line {note.line} ({note.side})"
          initial={note.body}
          onsave={async (body) => {
            const error = await review.updateNote(note.id, body)
            if (!error) editing = null
            return error
          }}
          oncancel={() => (editing = null)}
        />
      {:else}
        {#if showLine}
          <p class="m-0 mb-1 font-mono text-xs text-text-muted" data-note-line>
            line {note.line} ({note.side})
          </p>
        {/if}
        <p class="m-0 break-words whitespace-pre-wrap" data-note-body>{note.body}</p>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          {#if note.state === 'sent'}
            <span
              class="rounded-control border border-border-strong px-1.5 text-xs font-semibold text-text-muted"
              data-note-sent>Sent</span
            >
          {/if}
          {#if note.stale}
            <span
              class="rounded-control border border-attention/60 bg-attention/10 px-1.5 text-xs font-semibold text-attention-text"
              data-note-stale>Changed since you wrote this</span
            >
          {/if}
          {#if note.state === 'draft'}
            <Button onclick={() => (editing = note.id)}>Edit</Button>
            <Button onclick={() => void remove(note)}>Delete</Button>
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>
