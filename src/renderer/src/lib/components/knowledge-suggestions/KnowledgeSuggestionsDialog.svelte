<script lang="ts">
  import { tick } from 'svelte'
  import { knowledgeSuggestions } from '../../stores/knowledge-suggestions.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { eligibleSuggestionSections } from '../../knowledge-suggestions/sections'
  import { problemText } from '../../knowledge-suggestions/problem'
  import type { Section } from '@shared/types/section'
  import { shownNoteName } from '../../knowledge-suggestions/destination'
  import { openKnowledgeItem } from '../../navigate-knowledge'
  import Button from '../ui/Button.svelte'
  import Modal from '../ui/Modal.svelte'
  import KnowledgeSuggestionCard from './KnowledgeSuggestionCard.svelte'
  import KnowledgeSuggestionEditor from './KnowledgeSuggestionEditor.svelte'

  const ordered = $derived([...knowledgeSuggestions.list].sort((a, b) => b.createdAt - a.createdAt))

  let list: HTMLDivElement | undefined = $state()

  // The session's group sections for the editor's Section field: the open group's list when it is the
  // same group, else fetched when editing starts.
  let fetchedSections = $state.raw<Section[]>([])
  const groupId = $derived(activeSession.header?.groupId ?? null)
  const sections = $derived(
    eligibleSuggestionSections(
      groupDetail.groupId !== null && groupDetail.groupId === groupId
        ? groupDetail.sections
        : fetchedSections
    )
  )

  $effect(() => {
    if (knowledgeSuggestions.editingId === null || groupId === null) return
    if (groupDetail.groupId === groupId) return
    const requested = groupId
    void window.arc.invoke('sections:list', { groupId: requested }).then((result) => {
      if (result.ok && Array.isArray(result.data) && requested === groupId) {
        fetchedSections = result.data
      }
    })
  })

  function startEdit(id: string): void {
    void knowledgeSuggestions.startEdit(id)
  }

  // Cancel (and Escape) return to the card; focus goes back to its Edit button.
  function cancelEdit(id: string): void {
    knowledgeSuggestions.cancelEdit()
    void tick().then(() =>
      list
        ?.querySelector<HTMLElement>(
          `[data-knowledge-suggestion="${id}"] button[aria-label^="Edit:"]`
        )
        ?.focus()
    )
  }

  // Discard all asks inline in the footer; Keep (or Escape) puts the buttons back.
  let confirmingDiscard = $state(false)
  const batchLocked = $derived(
    knowledgeSuggestions.batchBusy || knowledgeSuggestions.editingId !== null
  )

  function footerButton(label: string): HTMLElement | undefined {
    return [
      ...(list
        ?.closest('[role="dialog"]')
        ?.querySelectorAll<HTMLElement>('[data-knowledge-suggestions-footer] button') ?? [])
    ].find((b) => b.textContent?.trim() === label)
  }

  function askDiscardAll(): void {
    confirmingDiscard = true
    void tick().then(() => footerButton('Keep')?.focus())
  }

  function keepSuggestions(): void {
    confirmingDiscard = false
    void tick().then(() => footerButton('Discard all')?.focus())
  }

  function runDiscardAll(): void {
    confirmingDiscard = false
    void knowledgeSuggestions.discardAll()
  }

  // Escape order: editor (stops its own Escape), then the confirmation, then the dialog.
  function cancelDialog(): void {
    if (confirmingDiscard) keepSuggestions()
    else knowledgeSuggestions.close()
  }

  // The confirmation names a count; drop it when fewer than two remain.
  $effect(() => {
    if (confirmingDiscard && ordered.length < 2) confirmingDiscard = false
  })

  // Announce the waiting count when it changes, not on first render.
  let announcement = $state('')
  let lastCount: number | null = null
  $effect(() => {
    const count = ordered.length
    if (lastCount !== null && count !== lastCount) {
      announcement =
        count === 0
          ? 'No suggestions waiting'
          : `${count} ${count === 1 ? 'suggestion' : 'suggestions'} waiting`
    }
    lastCount = count
  })

  // Accepting or discarding removes the focused button and leaves focus on <body> or the dialog frame.
  // Move focus to the next card's first button, else the confirmation's Open, else Close.
  $effect(() => {
    void ordered.length
    void knowledgeSuggestions.confirmations.length
    void knowledgeSuggestions.batchBusy
    void tick().then(() => {
      const panel = list?.closest('[role="dialog"]')
      const active = document.activeElement
      const stillUsable =
        active !== panel && panel?.contains(active) && !active?.matches(':disabled')
      if (!panel || stillUsable) return
      const target =
        panel.querySelector<HTMLElement>('[data-knowledge-suggestion] button:not([disabled])') ??
        panel.querySelector<HTMLElement>(
          '[data-knowledge-suggestion-confirmation] button:not([disabled])'
        ) ??
        panel.querySelector<HTMLElement>('button:not([disabled])')
      target?.focus()
    })
  })

  // Nothing left to decide and nothing to confirm (the last card was discarded): close. After an
  // accept the dialog stays so the confirmation and its Open button can be reached.
  $effect(() => {
    if (
      knowledgeSuggestions.dialogOpen &&
      knowledgeSuggestions.count === 0 &&
      knowledgeSuggestions.confirmations.length === 0 &&
      knowledgeSuggestions.busyIds.size === 0 &&
      !knowledgeSuggestions.batchBusy
    ) {
      knowledgeSuggestions.close()
    }
  })
</script>

{#if knowledgeSuggestions.dialogOpen}
  <Modal title="Knowledge suggestions" size="lg" onsubmit={() => {}} oncancel={cancelDialog}>
    <div
      bind:this={list}
      class="flex max-h-[min(60vh,32rem)] flex-col gap-3 overflow-y-auto pr-1"
      data-knowledge-suggestions-list
    >
      {#each knowledgeSuggestions.confirmations as confirmation (confirmation.id)}
        <div
          role="status"
          class="flex items-center justify-between gap-3 rounded-hud border border-border bg-surface-raised p-3 text-sm text-text"
          data-knowledge-suggestion-confirmation={confirmation.id}
        >
          <span
            >Added to {confirmation.outcome.sectionName} › {shownNoteName(
              confirmation.outcome.name
            )}</span
          >
          <Button
            ariaLabel="Open: {shownNoteName(confirmation.outcome.name)}"
            onclick={() => void openKnowledgeItem(confirmation.outcome)}>Open</Button
          >
        </div>
      {/each}
      {#if ordered.length === 0}
        <p class="text-sm text-text-muted" data-knowledge-suggestions-empty>
          No suggestions waiting.
        </p>
      {/if}
      {#each ordered as suggestion (suggestion.id)}
        <KnowledgeSuggestionCard
          {suggestion}
          problem={knowledgeSuggestions.problems[suggestion.id]}
          busy={knowledgeSuggestions.busyIds.has(suggestion.id)}
          currentText={knowledgeSuggestions.currentTexts[suggestion.id]}
          onshowcurrent={(id) => void knowledgeSuggestions.showCurrent(id)}
          onaddasnew={(id) => void knowledgeSuggestions.addAsNew(id)}
          onaccept={(id) => void knowledgeSuggestions.accept(id)}
          ondiscard={(id) => void knowledgeSuggestions.discard(id)}
          onedit={startEdit}
          editing={knowledgeSuggestions.editingId === suggestion.id}
        >
          {#snippet editor()}
            {#if knowledgeSuggestions.editSeedText === null && suggestion.kind === 'update'}
              <p class="text-sm text-text-muted" role="status" data-knowledge-suggestion-loading>
                Loading the text…
              </p>
            {:else}
              {@const problem = knowledgeSuggestions.problems[suggestion.id]}
              <KnowledgeSuggestionEditor
                {suggestion}
                asNew={knowledgeSuggestions.editsAsNew}
                seedText={suggestion.kind === 'new'
                  ? (suggestion.text ?? '')
                  : (knowledgeSuggestions.editSeedText ?? '')}
                {sections}
                error={knowledgeSuggestions.editError ??
                  (problem && problem.kind !== 'name-taken' ? problemText(problem) : null)}
                nameError={problem?.kind === 'name-taken' ? problemText(problem) : null}
                focus={knowledgeSuggestions.editFocus}
                busy={knowledgeSuggestions.busyIds.has(suggestion.id)}
                onaccept={(edits) => void knowledgeSuggestions.accept(suggestion.id, edits)}
                oncancel={() => cancelEdit(suggestion.id)}
              />
            {/if}
          {/snippet}
        </KnowledgeSuggestionCard>
      {/each}
    </div>
    <div class="sr-only" aria-live="polite" aria-atomic="true" data-knowledge-suggestions-live>
      {announcement}
    </div>
    <div class="flex items-center justify-end gap-2" data-knowledge-suggestions-footer>
      {#if confirmingDiscard}
        <span class="mr-auto text-sm text-text">Discard all {ordered.length} suggestions?</span>
        <Button variant="danger" onclick={runDiscardAll}>Discard</Button>
        <Button variant="secondary" onclick={keepSuggestions}>Keep</Button>
      {:else}
        {#if ordered.length > 1}
          <Button
            variant="primary"
            disabled={batchLocked}
            onclick={() => void knowledgeSuggestions.acceptAll()}>Accept all</Button
          >
          <Button variant="secondary" disabled={batchLocked} onclick={askDiscardAll}
            >Discard all</Button
          >
        {/if}
        <Button variant="secondary" onclick={() => knowledgeSuggestions.close()}>Close</Button>
      {/if}
    </div>
  </Modal>
{/if}
