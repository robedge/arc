<script lang="ts">
  import type { SessionMessage } from '@shared/types/session'
  import MarkdownPreview from '../items/MarkdownPreview.svelte'
  import Button from '../ui/Button.svelte'
  import AttachmentRow from '../ui/AttachmentRow.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { review } from '../../stores/review.svelte'
  import { knowledgeSuggestions } from '../../stores/knowledge-suggestions.svelte'
  import { suggestionsLine } from '../../knowledge-suggestions/line'

  let { message }: { message: SessionMessage } = $props()

  const streaming = $derived(message.state === 'streaming')
  const asMarkdown = $derived(message.role === 'brain' && !streaming)
  // A user message that starts with `/name` is a command: show that word in mono accent.
  const leadingCommand = $derived(
    message.role === 'user' ? (/^\/\S+/.exec(message.content)?.[0] ?? null) : null
  )
  const suggestions = $derived(
    message.prompt?.kind === 'knowledge-suggestions' ? message.prompt : null
  )
  // A system message stores this same sentence, so the line replaces its text.
  const showBody = $derived(!(suggestions && message.role === 'system'))
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
  {#if !showBody}
    <!-- the line below carries the sentence -->
  {:else if asMarkdown}
    <MarkdownPreview source={message.content} copyCode />
  {:else if message.content !== '' || !message.attachments?.length}
    <!-- prettier-ignore -->
    <p class="[overflow-wrap:anywhere] whitespace-pre-wrap">{#if leadingCommand}<span data-command class="font-mono text-accent">{leadingCommand}</span>{message.content.slice(leadingCommand.length)}{:else}{message.content}{/if}</p>
  {/if}
  {#if message.attachments?.length}
    <AttachmentRow
      scope="sent"
      items={message.attachments.map((a) => ({
        key: a.id,
        id: a.id,
        name: a.name,
        kind: a.kind,
        size: a.size
      }))}
    />
  {/if}
  {#if message.prompt?.kind === 'review-link'}
    {@const noChanges = activeSession.changedFileCount === 0}
    <span class="self-start" title={noChanges ? 'No changes yet' : undefined}>
      <Button ariaDisabled={noChanges} onclick={() => void review.openReview(message.sessionId)}
        >Review changes</Button
      >
    </span>
  {/if}
  {#if suggestions}
    {#if knowledgeSuggestions.count > 0}
      <button
        type="button"
        data-knowledge-suggestions-line
        onclick={() => knowledgeSuggestions.open()}
        class="min-h-[var(--size-hit)] cursor-pointer self-start rounded-control border-0 bg-transparent p-0 text-left text-sm text-accent underline hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
        >{suggestionsLine(suggestions.count)}</button
      >
    {:else}
      <p data-knowledge-suggestions-line class="text-sm">{suggestionsLine(suggestions.count)}</p>
    {/if}
  {/if}
  {#if message.state === 'stopped'}
    <span class="self-start text-xs tracking-label text-attention uppercase">Stopped</span>
  {/if}
</div>
