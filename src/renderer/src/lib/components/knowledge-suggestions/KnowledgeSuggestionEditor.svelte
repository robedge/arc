<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type {
    KnowledgeSuggestionEdits,
    KnowledgeSuggestionView
  } from '@shared/types/knowledge-suggestion'
  import { shownNoteName } from '../../knowledge-suggestions/destination'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Select from '../ui/Select.svelte'
  import TextArea from '../ui/TextArea.svelte'
  import TextField from '../ui/TextField.svelte'

  interface Props {
    suggestion: KnowledgeSuggestionView
    /** Offer Name and Section: a new note, or an update whose note is gone. */
    asNew: boolean
    /** The text the editor starts from: the view's text for a new note, the fetched full text for an update. */
    seedText: string
    /** The sections a note may go into, already filtered. */
    sections: readonly { id: string; name: string }[]
    /** A refusal to show under the fields (not the name-taken one). */
    error?: string | null
    /** Shown on the Name field. */
    nameError?: string | null
    /** Which field takes focus; a new `n` refocuses. */
    focus: { field: 'text' | 'name'; n: number }
    busy?: boolean
    /** Take focus on mount; the Design Preview turns it off so the page does not scroll. */
    autofocus?: boolean
    /** Called with only the fields the user changed; undefined when nothing changed. */
    onaccept: (edits: KnowledgeSuggestionEdits | undefined) => void
    oncancel: () => void
  }

  let {
    suggestion,
    asNew,
    seedText,
    sections,
    error = null,
    nameError = null,
    focus,
    busy = false,
    autofocus = true,
    onaccept,
    oncancel
  }: Props = $props()

  // The fields start from the values at mount; a pushed list must not overwrite what was typed.
  const seed = untrack(() => ({
    text: seedText.replace(/\r\n/g, '\n'),
    name: shownNoteName(suggestion.target.name),
    sectionId: suggestion.sectionId
  }))
  let text = $state(seed.text)
  let name = $state(seed.name)
  let sectionId = $state(seed.sectionId)
  let textInvalid = $state<string | null>(null)
  let nameInvalid = $state<string | null>(null)
  let root: HTMLDivElement | undefined = $state()

  const suggestionId = untrack(() => suggestion.id)
  const textId = `ks-edit-${suggestionId}-text`
  const nameId = `ks-edit-${suggestionId}-name`
  const sectionOptions = $derived.by(() => {
    const options = sections.map((s) => ({ value: s.id, label: s.name }))
    // The suggestion's own section stays selectable even if it is no longer in the list.
    if (!options.some((o) => o.value === suggestion.sectionId)) {
      options.unshift({ value: suggestion.sectionId, label: suggestion.sectionName })
    }
    return options
  })

  $effect(() => {
    if (!autofocus) return
    const wanted = focus.field === 'name' && asNew ? nameId : textId
    void focus.n
    void tick().then(() => root?.querySelector<HTMLElement>(`#${wanted}`)?.focus())
  })

  function submit(): void {
    if (busy) return
    textInvalid = text.trim() === '' ? 'Enter some text.' : null
    nameInvalid = asNew && name.trim() === '' ? 'Enter a name.' : null
    if (textInvalid || nameInvalid) return
    const edits: KnowledgeSuggestionEdits = {}
    if (text !== seed.text) edits.text = text
    if (asNew) {
      // An update added as a new note always carries the name: the main process needs it on that path.
      if (name.trim() !== seed.name || suggestion.kind === 'update') edits.name = name.trim()
      if (sectionId !== seed.sectionId) edits.sectionId = sectionId
    }
    onaccept(Object.keys(edits).length > 0 ? edits : undefined)
  }

  // Escape returns to the card; the dialog behind it stays open.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    oncancel()
  }

  function onnamekeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  }
</script>

<!-- Escape is caught here so it returns to the card instead of closing the dialog. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  bind:this={root}
  role="group"
  aria-label="Edit suggestion: {suggestion.title}"
  class="flex flex-col gap-3"
  data-knowledge-suggestion-editor={suggestion.id}
  {onkeydown}
>
  <TextArea
    id={textId}
    label="Text"
    rows={10}
    mono
    bind:value={text}
    error={textInvalid}
    oninput={() => (textInvalid = null)}
  />
  {#if asNew}
    <TextField
      id={nameId}
      label="Name"
      bind:value={name}
      error={nameInvalid ?? nameError}
      oninput={() => (nameInvalid = null)}
      onkeydown={onnamekeydown}
    />
    <Select
      id="ks-edit-{suggestion.id}-section"
      label="Section"
      bind:value={sectionId}
      options={sectionOptions}
    />
  {/if}
  {#if error}
    <ErrorText message={error} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button variant="primary" disabled={busy} onclick={submit}>Accept</Button>
    <Button variant="secondary" onclick={oncancel}>Cancel</Button>
  </div>
</div>
