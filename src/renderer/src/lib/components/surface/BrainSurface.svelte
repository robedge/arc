<script lang="ts">
  // A surface on a brain message: a click becomes a `[Surface action]` user message.
  import { SURFACE_ACTION_PREFIX, type Surface, type SurfaceAction } from '@shared/surface'
  import SurfaceView from './SurfaceView.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { messageFor } from '../../ipc/messages'

  interface Props {
    surface: Surface
    sessionId: string
    messageId: number
  }

  let { surface, sessionId, messageId }: Props = $props()

  let sent = $state<string | null>(null)

  async function send(action: SurfaceAction): Promise<string | null> {
    const body = `${SURFACE_ACTION_PREFIX}${JSON.stringify(action)}`
    const res = await window.arc.invoke('sessions:send-message', { sessionId, text: body })
    if (!res.ok) return messageFor(res.error)
    sent = action.label
    const now = Date.now()
    activeSession.addUserMessage({
      id: res.data.messageId,
      sessionId,
      role: 'user',
      content: body,
      state: 'complete',
      planId: null,
      createdAt: now,
      updatedAt: now
    })
    return null
  }
</script>

<div class="flex w-full min-w-[16rem] flex-col gap-2">
  <SurfaceView {surface} idPrefix="surface-{messageId}" onAction={send} />
  {#if sent !== null}
    <span class="text-xs tracking-label text-text-muted uppercase">Last sent: {sent}</span>
  {/if}
</div>
