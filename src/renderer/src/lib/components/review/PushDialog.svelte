<script lang="ts">
  import type { AppError } from '@shared/errors'
  import { messageFor } from '../../ipc/messages'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    repoName: string
    /** The exact command, from `review:push-preview`. */
    command: string
    remote: string
    /** Runs the push; resolves to the error, or null on success. */
    onconfirm: () => Promise<AppError | null>
    oncancel: () => void
    /** Called after a successful push so the caller can close and restore focus. */
    ondone: () => void
    /** Design Preview only: show the busy state without calling anything. */
    busy?: boolean
    /** Design Preview only: show this failure from the start. */
    failure?: AppError
  }

  let {
    repoName,
    command,
    remote,
    onconfirm,
    oncancel,
    ondone,
    busy: forcedBusy = false,
    failure
  }: Props = $props()

  let working = $state(false)
  let failed = $state<AppError | null>(null)
  const busy = $derived(working || forcedBusy)
  const shown = $derived(failed ?? failure ?? null)

  async function onsubmit(): Promise<void> {
    if (busy) return
    working = true
    failed = null
    try {
      const err = await onconfirm()
      if (err) failed = err
      else ondone()
    } finally {
      working = false
    }
  }
</script>

<Modal title="Push branch" {onsubmit} {oncancel} size="lg" {busy}>
  <p class="text-sm text-text">Push {repoName} to <span class="font-mono">{remote}</span>?</p>
  <code
    class="block rounded-control border border-border bg-surface-code px-3 py-2 font-mono text-sm break-all text-text-bright"
    data-push-command>{command}</code
  >
  {#if shown}
    <div class="flex flex-col gap-2" data-push-error>
      <ErrorText message={messageFor(shown)} />
      {#if shown.details?.reason}
        <!-- A scrollable region needs the tab stop so keyboard users can read a long message. -->
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <pre
          role="region"
          tabindex="0"
          aria-label="Message from git"
          class="max-h-48 overflow-auto rounded-control border border-border bg-surface-code px-3 py-2 font-mono text-xs whitespace-pre-wrap text-text">{shown
            .details.reason}</pre>
      {/if}
    </div>
  {/if}
  <div class="flex justify-end gap-2">
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button type="submit" variant="primary" {busy} disabled={busy}>Push</Button>
  </div>
</Modal>
