<script lang="ts">
  import type { Suggestion, SuggestionKind } from '@shared/types/usage'
  import { tick } from 'svelte'
  import { openSession } from '../../navigate-session'
  import { ui } from '../../stores/ui.svelte'
  import { cliHeavySetup } from '../../usage/derive'

  interface Props {
    suggestions: Suggestion[]
    /** True on the Usage page, where each item links to its session. */
    showSessionLink?: boolean
    /** Shown when there are no suggestions; without it an empty list renders nothing. */
    emptyText?: string
    /** Heading level: 2 as a page section, 3 inside the usage panel. */
    level?: 2 | 3
    ondismiss: (id: string) => void
  }

  let { suggestions, showSessionLink = false, emptyText, level = 3, ondismiss }: Props = $props()

  const KIND_LABELS: Record<SuggestionKind, string> = {
    'model-too-strong': 'Model too strong',
    'setup-overhead': 'Setup overhead',
    'repeated-work': 'Repeated work',
    'long-running': 'Long-running agent'
  }

  let root: HTMLElement | undefined = $state()
  let heading: HTMLElement | undefined = $state()

  async function dismiss(id: string): Promise<void> {
    const index = suggestions.findIndex((s) => s.id === id)
    const nextId = suggestions[index + 1]?.id ?? suggestions[index - 1]?.id
    const fallback = root?.closest<HTMLElement>('[role="dialog"]') ?? null
    ondismiss(id)
    await tick()
    const target = nextId
      ? root?.querySelector<HTMLElement>(`[data-suggestion-id="${CSS.escape(nextId)}"] button`)
      : null
    ;(target ?? heading ?? fallback)?.focus()
  }
</script>

{#if suggestions.length > 0 || emptyText}
  <section bind:this={root} aria-labelledby="suggestions-heading-{level}" data-suggestions>
    <svelte:element
      this={`h${level}`}
      id="suggestions-heading-{level}"
      bind:this={heading}
      tabindex="-1"
      class="text-sm font-semibold tracking-label text-text-muted uppercase focus:outline-none focus-visible:shadow-focus"
      >Suggestions</svelte:element
    >
    {#if suggestions.length === 0}
      <p class="mt-2 text-sm text-text-muted" data-suggestions-empty>{emptyText}</p>
    {:else}
      <ul role="list" class="mt-2 flex flex-col divide-y divide-border">
        {#each suggestions as s (s.id)}
          {@const label = KIND_LABELS[s.kind]}
          <li
            class="flex items-start justify-between gap-3 py-2"
            data-suggestion={s.kind}
            data-suggestion-id={s.id}
          >
            <div class="flex min-w-0 flex-col gap-0.5 text-xs">
              <span class="tracking-label text-accent uppercase">{label}</span>
              <span class="text-text">{s.text}</span>
              <span class="text-text-muted">Try: {s.advice}</span>
              {#if s.kind === 'setup-overhead' && cliHeavySetup(s.params)}
                <button
                  type="button"
                  class="min-h-[var(--size-hit)] w-fit rounded-control border border-border-strong px-3 text-xs font-semibold tracking-label text-text uppercase focus:outline-none focus-visible:shadow-focus"
                  data-suggestion-agent-load
                  onclick={() => ui.openSettings('agent-load')}>Choose what agents load</button
                >
              {/if}
              {#if showSessionLink}
                <button
                  type="button"
                  class="w-fit text-left text-text-bright underline focus:outline-none focus-visible:shadow-focus"
                  data-suggestion-session
                  onclick={() => void openSession(s.sessionId)}>{s.sessionName}</button
                >
              {/if}
            </div>
            <button
              type="button"
              aria-label="Dismiss suggestion: {label} in {s.sessionName}"
              class="min-h-[var(--size-hit)] shrink-0 rounded-control border border-border-strong px-3 text-xs font-semibold tracking-label text-text uppercase focus:outline-none focus-visible:shadow-focus"
              data-suggestion-dismiss
              onclick={() => void dismiss(s.id)}>Dismiss</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
