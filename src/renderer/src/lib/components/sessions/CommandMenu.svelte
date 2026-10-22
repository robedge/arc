<script lang="ts">
  import type { CommandInfo } from '@shared/types/commands'
  import type { CommandsStatus } from '../../stores/commands.svelte'
  import Button from '../ui/Button.svelte'
  import { commandOptionId } from './command-filter'

  interface Props {
    /** Id of the listbox, referenced by the textarea's aria-controls. */
    id: string
    status: CommandsStatus
    /** Already filtered and ordered. */
    commands: CommandInfo[]
    activeIndex: number
    onpick: (command: CommandInfo) => void
    onretry: () => void
    /** In flow instead of floating above the box (Design Preview). */
    inline?: boolean
  }

  let { id, status, commands, activeIndex, onpick, onretry, inline = false }: Props = $props()

  const hasList = $derived(commands.length > 0)
  const count = $derived(
    status === 'error' && !hasList
      ? "Couldn't load commands"
      : status === 'loading' && !hasList
        ? 'Loading commands'
        : hasList
          ? `${commands.length} ${commands.length === 1 ? 'command' : 'commands'}`
          : 'No matching commands'
  )

  function badges(command: CommandInfo): { label: string; muted: boolean }[] {
    const source = command.source
    if (source === 'codex') {
      return [
        { label: 'Codex', muted: false },
        { label: command.kind, muted: true }
      ]
    }
    if (source === 'cursor') {
      return [
        { label: 'Cursor', muted: false },
        { label: command.kind, muted: true }
      ]
    }
    if (source === 'user') return [{ label: 'Yours', muted: false }]
    if (source.startsWith('plugin:')) {
      return [
        { label: 'Yours', muted: false },
        { label: source.slice('plugin:'.length), muted: true }
      ]
    }
    return [{ label: source.slice('repo:'.length), muted: false }]
  }

  // Keep the highlighted option in view as Up and Down move through a long list.
  $effect(() => {
    if (!hasList) return
    document
      .getElementById(commandOptionId(id, activeIndex))
      ?.scrollIntoView?.({ block: 'nearest' })
  })
</script>

<div
  data-command-menu
  class="{inline
    ? 'relative'
    : 'absolute right-0 bottom-full left-0 z-10 mb-1'} flex max-h-64 flex-col overflow-hidden rounded-hud border border-border-strong bg-surface-raised shadow-glow-accent"
>
  <span class="sr-only" role="status" aria-live="polite">{count}</span>
  {#if hasList}
    <ul {id} role="listbox" aria-label="Commands" class="m-0 flex flex-col overflow-y-auto p-1">
      {#each commands as command, index (command.id)}
        {@const active = index === activeIndex}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          id={commandOptionId(id, index)}
          role="option"
          aria-selected={active}
          data-active={active}
          onmousedown={(event) => event.preventDefault()}
          onclick={() => onpick(command)}
          class="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-control px-2 py-1.5 {active
            ? 'bg-accent/15'
            : 'hover:bg-accent/10'}"
        >
          <span class="flex min-w-0 items-center gap-2">
            <span class="shrink-0 font-mono text-sm text-accent">/{command.name}</span>
            {#if command.argumentHint}
              <span class="min-w-0 truncate font-mono text-xs text-text-faint"
                >{command.argumentHint}</span
              >
            {/if}
            <span class="ml-auto flex shrink-0 items-center gap-1">
              {#each badges(command) as badge (badge.label)}
                <span
                  data-badge
                  class="rounded-control border px-1.5 text-xs {badge.muted
                    ? 'border-border text-text-faint'
                    : 'border-border-strong text-text-muted'}">{badge.label}</span
                >
              {/each}
            </span>
          </span>
          {#if command.description}
            <span class="truncate text-xs text-text-muted">{command.description}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {:else if status === 'loading'}
    <p class="m-0 px-3 py-2 text-sm text-text-muted">Loading commands…</p>
  {:else if status === 'error'}
    <div class="flex items-center justify-between gap-3 px-3 py-2">
      <p class="m-0 text-sm text-text-muted">Couldn't load commands. You can still send.</p>
      <Button onclick={onretry}>Retry</Button>
    </div>
  {:else}
    <div class="flex flex-col gap-0.5 px-3 py-2">
      <p class="m-0 text-sm text-text">No matching commands</p>
      <p class="m-0 text-xs text-text-muted">Sent to the brain as a message</p>
    </div>
  {/if}
</div>
