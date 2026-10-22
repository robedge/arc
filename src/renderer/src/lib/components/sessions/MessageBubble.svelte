<script lang="ts">
  import type { SessionMessage } from '@shared/types/session'
  import MarkdownPreview from '../items/MarkdownPreview.svelte'
  import Button from '../ui/Button.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { review } from '../../stores/review.svelte'

  let { message }: { message: SessionMessage } = $props()

  const streaming = $derived(message.state === 'streaming')
  const asMarkdown = $derived(message.role === 'brain' && !streaming)
  // A user message that starts with `/name` is a command: show that word in mono accent.
  const leadingCommand = $derived(
    message.role === 'user' ? (/^\/\S+/.exec(message.content)?.[0] ?? null) : null
  )
  const LAYOUT = {
    user: 'self-end border-border-strong bg-accent/10',
    brain: 'self-start border-border bg-surface-raised',
    system: 'self-center border-border bg-surface-code text-text-muted'
  } as const
</script>

<div
  data-message-role={message.role}
  data-message-state={message.state}
  class="flex max-w-[85%] min-w-0 shrink-0 flex-col gap-1 rounded-hud border px-3 py-2 text-sm text-text {LAYOUT[
    message.role
  ]}"
>
  {#if asMarkdown}
    <MarkdownPreview source={message.content} copyCode />
  {:else}
    <!-- prettier-ignore -->
    <p class="[overflow-wrap:anywhere] whitespace-pre-wrap">{#if leadingCommand}<span data-command class="font-mono text-accent">{leadingCommand}</span>{message.content.slice(leadingCommand.length)}{:else}{message.content}{/if}</p>
  {/if}
  {#if message.prompt?.kind === 'review-link'}
    {@const noChanges = activeSession.changedFileCount === 0}
    <span class="self-start" title={noChanges ? 'No changes yet' : undefined}>
      <Button ariaDisabled={noChanges} onclick={() => void review.openReview(message.sessionId)}
        >Review changes</Button
      >
    </span>
  {/if}
  {#if message.state === 'stopped'}
    <span class="self-start text-xs tracking-label text-attention uppercase">Stopped</span>
  {/if}
</div>
