<script lang="ts">
  import type { SessionSummary } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { activeSession } from '../../stores/active-session.svelte'
  import { sessionsList } from '../../stores/sessions-list.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    session: Pick<SessionSummary, 'id' | 'name'>
    onclose: () => void
  }

  let { session, onclose }: Props = $props()

  let busy = $state(false)
  let error = $state<string | null>(null)

  async function onsubmit(): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      const res = await window.harness.invoke('sessions:delete', { sessionId: session.id })
      if (!res.ok) {
        error = messageFor(res.error)
        return
      }
      sessionsList.remove(session.id)
      if (activeSession.sessionId === session.id) activeSession.close()
      onclose()
    } finally {
      busy = false
    }
  }
</script>

<Modal title="Delete Session" {onsubmit} oncancel={onclose} size="sm" {busy}>
  <p class="text-sm text-text">
    Delete the session <strong class="text-text">{session.name}</strong>? Its branches are kept in
    your repositories. Any unmerged worker working copies will be removed. Its token usage stays in
    the Usage page history.
  </p>
  {#if error}<ErrorText message={error} />{/if}
  <div class="flex justify-end gap-2">
    <Button onclick={onclose}>Cancel</Button>
    <Button type="submit" variant="danger" disabled={busy}>Delete</Button>
  </div>
</Modal>
