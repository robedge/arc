<script lang="ts">
  import type { AppError } from '@shared/errors'
  import Modal from '../ui/Modal.svelte'
  import TextField from '../ui/TextField.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    title: string
    label: string
    confirmText: string
    initialValue?: string
    /** Returns an error message, or null when the value is acceptable. */
    validate: (value: string) => string | null
    /** Returns an AppError (shown inline) or null on success. */
    submit: (value: string) => Promise<AppError | null>
    /** Maps a server error to display text. */
    formatError: (error: AppError) => string
    onclose: () => void
  }

  let {
    title,
    label,
    confirmText,
    initialValue = '',
    validate,
    submit,
    formatError,
    onclose
  }: Props = $props()

  // svelte-ignore state_referenced_locally
  let value = $state(initialValue)
  let attempted = $state(false)
  let serverError = $state<string | null>(null)
  let busy = $state(false)

  let clientError = $derived(attempted ? validate(value) : null)
  let error = $derived(clientError ?? serverError)

  function oninput(): void {
    serverError = null
  }

  async function onsubmit(): Promise<void> {
    if (busy) return
    attempted = true
    if (validate(value) !== null) return
    busy = true
    try {
      const failure = await submit(value)
      if (failure) serverError = formatError(failure)
      else onclose()
    } finally {
      busy = false
    }
  }
</script>

<Modal {title} {onsubmit} oncancel={onclose} size="sm" {busy}>
  <TextField id="name-dialog-input" {label} bind:value {error} {oninput} />
  <div class="flex justify-end gap-2">
    <Button onclick={onclose}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={busy}>{confirmText}</Button>
  </div>
</Modal>
