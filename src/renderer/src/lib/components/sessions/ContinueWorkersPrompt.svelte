<script lang="ts">
  import type { MessagePrompt, SessionMessage } from '@shared/types/session'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import { continueAll } from './worker-actions'
  import { messageFor } from '../../ipc/messages'

  let {
    message,
    prompt
  }: { message: SessionMessage; prompt: Extract<MessagePrompt, { kind: 'continue-workers' }> } =
    $props()

  let busy = $state(false)
  let error = $state<string | null>(null)

  const open = $derived(prompt.status === 'open')

  async function resume(): Promise<void> {
    busy = true
    error = await continueAll(message.sessionId)
    busy = false
  }

  async function dismiss(): Promise<void> {
    busy = true
    error = null
    const res = await window.harness.invoke('sessions:dismiss-prompt', {
      sessionId: message.sessionId,
      messageId: message.id
    })
    busy = false
    if (!res.ok) error = messageFor(res.error)
  }
</script>

<div
  data-message-role="system"
  data-continue-prompt={prompt.status}
  class="flex max-w-[85%] min-w-0 shrink-0 flex-col gap-2 self-center rounded-hud border border-border bg-surface-code px-3 py-2 text-sm text-text-muted"
>
  <p class="break-words whitespace-pre-wrap">{message.content}</p>
  {#if open}
    <div class="flex gap-2">
      <Button variant="primary" {busy} onclick={() => void resume()}>Continue</Button>
      <Button disabled={busy} onclick={() => void dismiss()}>Not now</Button>
    </div>
  {:else}
    <span class="self-start text-xs tracking-label text-text-faint uppercase" data-prompt-outcome
      >{prompt.status === 'continued' ? 'Continued' : 'Not now'}</span
    >
  {/if}
  {#if error}<ErrorText message={error} />{/if}
</div>
