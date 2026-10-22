<script lang="ts">
  import type { AppError } from '@shared/errors'
  import { onMount } from 'svelte'
  import { messageFor } from '../../ipc/messages'
  import Button from '../ui/Button.svelte'
  import TextArea from '../ui/TextArea.svelte'

  interface Props {
    id: string
    /** Accessible name of the text box, e.g. "Note on line 42 (new)". */
    label: string
    initial?: string
    /** Returns the error to show, or null once saved. */
    onsave: (body: string) => Promise<AppError | null>
    oncancel: () => void
  }

  let { id, label, initial = '', onsave, oncancel }: Props = $props()

  // svelte-ignore state_referenced_locally
  let body = $state(initial)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const empty = $derived(body.trim() === '')

  onMount(() => document.getElementById(id)?.focus())

  async function save(): Promise<void> {
    if (empty || busy) return
    busy = true
    error = null
    const failure = await onsave(body.trim())
    busy = false
    if (failure) error = messageFor(failure)
  }

  // Esc cancels and Cmd/Ctrl+Enter saves; the key never reaches the review shortcuts.
  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      oncancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }
</script>

<!-- The key handler sits on the wrapper so it covers the text box and both buttons. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flex flex-col gap-2" {onkeydown} data-note-composer>
  <TextArea {id} {label} hideLabel rows={3} bind:value={body} {error} maxlength={4000} />
  <div class="flex items-center gap-2">
    <Button variant="primary" disabled={empty} {busy} onclick={() => void save()}>Save</Button>
    <Button onclick={oncancel}>Cancel</Button>
  </div>
</div>
