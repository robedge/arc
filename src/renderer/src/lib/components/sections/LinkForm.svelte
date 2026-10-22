<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import { ITEM_DESCRIPTION_MAX } from '@shared/limits'
  import type { AppError } from '@shared/errors'
  import type { ItemSummary } from '@shared/types/item'
  import { validateLinkUrl } from '../../link-url'
  import Modal from '../ui/Modal.svelte'
  import TextField from '../ui/TextField.svelte'
  import Button from '../ui/Button.svelte'

  interface LinkValues {
    url: string
    title: string
    description: string
  }

  interface Props {
    /** The link being edited; null adds a new one. */
    item?: ItemSummary | null
    /** Returns an AppError (shown inline) or null on success. */
    submit: (values: LinkValues) => Promise<AppError | null>
    /** Maps a server error to display text. */
    formatError: (error: AppError) => string
    onclose: () => void
  }

  let { item = null, submit, formatError, onclose }: Props = $props()

  // svelte-ignore state_referenced_locally
  let url = $state(item?.url ?? '')
  // svelte-ignore state_referenced_locally
  let title = $state(item?.title && item.title !== item.url ? item.title : '')
  // svelte-ignore state_referenced_locally
  let description = $state(item?.description ?? '')
  let attempted = $state(false)
  let serverError = $state<{ code: AppError['code']; text: string } | null>(null)
  let busy = $state(false)

  const urlError = $derived(
    (attempted ? validateLinkUrl(url) : null) ??
      (serverError?.code === 'LINK_URL_INVALID' ? serverError.text : null)
  )
  // Any other server failure has no field of its own, so it shows above the buttons.
  const formError = $derived(serverError?.code === 'LINK_URL_INVALID' ? null : serverError?.text)

  function oninput(): void {
    serverError = null
  }

  async function onsubmit(): Promise<void> {
    if (busy) return
    attempted = true
    if (validateLinkUrl(url) !== null) return
    busy = true
    try {
      const failure = await submit({ url, title, description })
      if (failure) serverError = { code: failure.code, text: formatError(failure) }
      else onclose()
    } finally {
      busy = false
    }
  }
</script>

<Modal title={item ? 'Edit Link' : 'Add Link'} {onsubmit} oncancel={onclose} {busy}>
  <TextField id="link-url" label="Address" bind:value={url} error={urlError} {oninput} />
  <TextField id="link-title" label="Title (optional)" bind:value={title} {oninput} />
  <TextField
    id="link-description"
    label="Description (optional)"
    bind:value={description}
    maxlength={ITEM_DESCRIPTION_MAX}
    {oninput}
  />
  {#if formError}
    <ErrorText message={formError} />
  {/if}
  <div class="flex justify-end gap-2">
    <Button onclick={onclose}>Cancel</Button>
    <Button type="submit" variant="primary" disabled={busy}>{item ? 'Save' : 'Add'}</Button>
  </div>
</Modal>
