<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { ButtonVariant } from './kinds'
  import Button from './Button.svelte'
  import Modal from './Modal.svelte'

  interface Props {
    title: string
    /** Plain text, or a snippet for richer content. */
    body: string | Snippet
    confirmLabel: string
    confirmVariant?: ButtonVariant
    cancelLabel?: string
    onconfirm: () => void
    oncancel: () => void
  }

  let {
    title,
    body,
    confirmLabel,
    confirmVariant = 'danger',
    cancelLabel = 'Cancel',
    onconfirm,
    oncancel
  }: Props = $props()
</script>

<!-- Cancel is first in the DOM so the Modal's initial focus lands on it; Enter there cancels. The
     confirm button is type="button", so Enter never submits the form into a confirmation. -->
<Modal {title} onsubmit={oncancel} {oncancel} size="sm">
  {#if typeof body === 'string'}
    <p class="text-sm text-text">{body}</p>
  {:else}
    {@render body()}
  {/if}
  <div class="flex justify-end gap-2">
    <Button type="button" onclick={oncancel}>{cancelLabel}</Button>
    <Button type="button" variant={confirmVariant} onclick={onconfirm}>{confirmLabel}</Button>
  </div>
</Modal>
