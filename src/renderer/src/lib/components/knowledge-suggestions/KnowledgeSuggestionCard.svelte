<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { KnowledgeSuggestionView } from '@shared/types/knowledge-suggestion'
  import { destinationText, shownNoteName } from '../../knowledge-suggestions/destination'
  import {
    canRetry,
    problemText,
    type KnowledgeSuggestionProblem
  } from '../../knowledge-suggestions/problem'
  import Button from '../ui/Button.svelte'
  import DiffSnippet from '../ui/DiffSnippet.svelte'
  import ErrorText from '../ui/ErrorText.svelte'

  interface Props {
    suggestion: KnowledgeSuggestionView
    ondiscard: (id: string) => void
    onaccept: (id: string) => void
    /** An accept is in flight. */
    busy?: boolean
    problem?: KnowledgeSuggestionProblem
    /** Show current: fetch the note's present text. */
    onshowcurrent?: (id: string) => void
    /** Add as a new note, for an update whose note is gone. */
    onaddasnew?: (id: string) => void
    /** The fetched current text, once Show current ran. */
    currentText?: string
    /** The card is in edit mode: the editor replaces the body and the buttons. */
    editing?: boolean
    editor?: Snippet
    onedit?: (id: string) => void
  }

  let {
    suggestion,
    ondiscard,
    onaccept,
    busy = false,
    problem,
    onshowcurrent,
    onaddasnew,
    currentText,
    editing = false,
    editor,
    onedit
  }: Props = $props()

  const message = $derived(problem ? problemText(problem) : null)
  // A changed or missing note cannot be accepted as shown; accepting again would fail the same way.
  const canAccept = $derived(problem?.kind !== 'changed' && problem?.kind !== 'missing')
</script>

<article
  class="flex flex-col gap-3 rounded-hud border border-accent/45 bg-accent/10 p-4"
  data-knowledge-suggestion={suggestion.id}
  data-kind={suggestion.kind}
  aria-label="Knowledge suggestion: {suggestion.title}"
>
  <div class="flex flex-col gap-1">
    <h3 class="text-sm font-semibold text-text-bright">{suggestion.title}</h3>
    <p class="text-sm text-text-muted">{suggestion.reason}</p>
    <p class="text-xs font-semibold tracking-label text-accent uppercase" data-destination>
      {destinationText(suggestion)}
    </p>
  </div>
  {#if editing && editor}
    {@render editor()}
  {:else}
    {#if suggestion.kind === 'new' && suggestion.text !== undefined}
      <pre
        class="max-h-48 overflow-auto rounded-control border border-border bg-surface-code p-3 font-mono text-xs whitespace-pre-wrap text-text"
        data-suggestion-text>{suggestion.text}</pre>
    {/if}
    {#if suggestion.kind === 'update'}
      {#if suggestion.hunks && suggestion.hunks.length > 0}
        <DiffSnippet
          hunks={suggestion.hunks}
          label="Changes to {shownNoteName(suggestion.target.name)}"
        />
      {:else}
        <p class="text-sm text-text-muted" data-too-large>
          This note is too large to show the changes here.
        </p>
      {/if}
    {/if}
    {#if currentText !== undefined}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <pre
        role="region"
        aria-label="Current note"
        tabindex="0"
        class="max-h-48 overflow-auto rounded-control border border-border bg-surface-code p-3 font-mono text-xs whitespace-pre-wrap text-text focus-visible:shadow-focus focus-visible:outline-none"
        data-current-note>{currentText}</pre>
    {/if}
    {#if message !== null}
      <div
        class="flex flex-wrap items-start justify-between gap-2"
        data-knowledge-suggestion-problem
      >
        <ErrorText {message} />
        {#if problem && canRetry(problem)}
          <Button disabled={busy} onclick={() => onaccept(suggestion.id)}>Try again</Button>
        {/if}
      </div>
    {/if}
    <div class="flex justify-end gap-2">
      {#if problem?.kind === 'changed'}
        <Button variant="secondary" onclick={() => onshowcurrent?.(suggestion.id)}
          >Show current</Button
        >
      {/if}
      {#if problem?.kind === 'missing'}
        <Button variant="primary" disabled={busy} onclick={() => onaddasnew?.(suggestion.id)}
          >Add as a new note</Button
        >
      {/if}
      {#if canAccept}
        <Button
          variant="primary"
          disabled={busy}
          ariaLabel="Accept: {suggestion.title}"
          onclick={() => onaccept(suggestion.id)}>Accept</Button
        >
      {/if}
      {#if problem?.kind !== 'changed'}
        <Button
          variant="secondary"
          ariaLabel="Edit: {suggestion.title}"
          onclick={() => onedit?.(suggestion.id)}>Edit</Button
        >
      {/if}
      <Button
        variant="secondary"
        ariaLabel="Discard: {suggestion.title}"
        onclick={() => ondiscard(suggestion.id)}>Discard</Button
      >
    </div>
  {/if}
</article>
