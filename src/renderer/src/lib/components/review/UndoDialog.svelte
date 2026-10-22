<script lang="ts">
  import type { AppError } from '@shared/errors'
  import { messageFor } from '../../ipc/messages'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    repoName: string
    branch: string
    path: string
    /** Labels of workers still working on the file ("W2"). */
    activeWorkers: string[]
    /** Runs the undo; resolves to the error, or null on success. */
    onconfirm: () => Promise<AppError | null>
    oncancel: () => void
    /** Called after a successful undo so the caller can close and restore focus. */
    ondone: () => void
    /** Design Preview only: show the busy state without calling anything. */
    busy?: boolean
  }

  let {
    repoName,
    branch,
    path,
    activeWorkers,
    onconfirm,
    oncancel,
    ondone,
    busy: forcedBusy = false
  }: Props = $props()

  let working = $state(false)
  let error = $state<string | null>(null)
  const busy = $derived(working || forcedBusy)

  const warning = $derived.by(() => {
    const names = activeWorkers
    if (names.length === 0) return null
    if (names.length === 1) {
      return `${names[0]} is still working on this file. Its next merge may bring the change back.`
    }
    const list = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    return `${list} are still working on this file. Their next merge may bring the change back.`
  })

  async function onsubmit(): Promise<void> {
    if (busy) return
    working = true
    error = null
    try {
      const err = await onconfirm()
      if (err) error = messageFor(err)
      else ondone()
    } finally {
      working = false
    }
  }
</script>

<Modal title="Undo changes" {onsubmit} {oncancel} size="md" {busy}>
  <p class="text-sm text-text">
    Undo all of this session's changes to <code class="font-mono">{repoName}/{path}</code>? This
    adds a commit to {branch}.
  </p>
  {#if warning}<p class="text-sm text-attention-text" data-undo-warning>{warning}</p>{/if}
  {#if error}<ErrorText message={error} />{/if}
  <div class="flex justify-end gap-2">
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button type="submit" variant="danger" {busy} disabled={busy}>Undo changes</Button>
  </div>
</Modal>
