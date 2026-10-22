<script lang="ts">
  import { tick } from 'svelte'
  import type { SessionEventEntry } from '@shared/types/session'
  import Icon from '../ui/Icon.svelte'
  import Panel from '../ui/Panel.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { cursorBlockedRest, eventStyle, parseCursorBlocked } from './event-kinds'
  import { WORKER_TONE_CLASS } from './worker-status'

  let { events }: { events: readonly SessionEventEntry[] } = $props()

  let scroller: HTMLDivElement | undefined = $state()

  function time(at: number): string {
    return new Date(at).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  /** Brings the worker's card into view and focuses it. */
  function showWorker(workerId: string): void {
    const card = document.querySelector<HTMLElement>(`[data-worker-id="${CSS.escape(workerId)}"]`)
    if (!card) return
    card.scrollIntoView?.({ block: 'nearest' })
    card.querySelector<HTMLElement>('button')?.focus()
  }

  $effect(() => {
    void events.length
    void tick().then(() => {
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
  })
</script>

<Panel title="Event log" class="h-full min-h-0">
  <div class="relative mt-1 h-full min-h-0">
    <div bind:this={scroller} class="absolute inset-0 overflow-auto px-3 py-1" data-event-log>
      {#if events.length === 0}
        <p class="py-2 text-xs text-text-faint">No events yet.</p>
      {:else}
        <ul>
          {#each events as entry (entry.id)}
            {@const style = eventStyle(entry.kind)}
            {@const blocked =
              entry.kind === 'cursor-blocked' && entry.workerId
                ? parseCursorBlocked(entry.dataJson)
                : null}
            <li class="flex h-6 items-center gap-2 text-xs" data-event-kind={entry.kind}>
              <span class="shrink-0 font-mono text-text-faint">{time(entry.at)}</span>
              {#if style}
                <span class="shrink-0 {WORKER_TONE_CLASS[style.tone]}" data-event-icon={style.icon}>
                  <Icon name={style.icon} size={14} title={style.label} />
                </span>
              {/if}
              {#if blocked && entry.workerId}
                {@const workerId = entry.workerId}
                {@const name = `W${activeSession.workers.find((w) => w.id === workerId)?.number ?? '?'}`}
                {@const sentence = `${name} ${cursorBlockedRest(blocked)}`}
                <span class="flex min-w-0 items-center gap-1" title={sentence}>
                  <button
                    type="button"
                    aria-label="Show {name}"
                    onclick={() => showWorker(workerId)}
                    class="shrink-0 rounded-control px-1 font-mono text-accent focus:outline-none focus-visible:shadow-focus"
                    >{name}</button
                  >
                  <span class="truncate text-text-muted">{cursorBlockedRest(blocked)}</span>
                </span>
              {:else}
                <span class="truncate text-text-muted" title={entry.text}>{entry.text}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</Panel>
