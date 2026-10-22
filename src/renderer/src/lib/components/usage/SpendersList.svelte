<script lang="ts">
  import type { SpenderKind, SpenderRow } from '@shared/types/usage'
  import { openSession } from '../../navigate-session'
  import EmptyState from '../ui/EmptyState.svelte'
  import TokenCount from '../ui/TokenCount.svelte'
  import Segmented from './Segmented.svelte'
  import { providerModelText } from './labels'

  interface Props {
    spenders: Record<SpenderKind, SpenderRow[]>
    kind: SpenderKind
  }

  let { spenders, kind = $bindable() }: Props = $props()

  const options = [
    { value: 'session', label: 'Sessions' },
    { value: 'worker', label: 'Workers' },
    { value: 'command', label: 'Commands' }
  ] as const satisfies readonly { value: SpenderKind; label: string }[]

  const rows = $derived(spenders[kind])

  /** "Group · Claude · Sonnet · 3 runs". */
  function detail(row: SpenderRow): string {
    return [
      row.groupName,
      providerModelText(row.provider, row.model),
      row.runs === undefined ? null : `${row.runs} ${row.runs === 1 ? 'run' : 'runs'}`
    ]
      .filter((part) => part !== null && part !== '')
      .join(' · ')
  }

  function opens(row: SpenderRow): string | null {
    return kind !== 'command' && row.clickable && row.sessionId ? row.sessionId : null
  }
</script>

{#snippet content(row: SpenderRow)}
  <span class="flex min-w-0 flex-1 flex-col text-left">
    <span class="truncate text-text-bright">{row.name}</span>
    <span class="truncate text-xs text-text-muted">{detail(row)}</span>
  </span>
  <TokenCount value={row.total} class="shrink-0" />
{/snippet}

<section aria-labelledby="usage-spenders" class="flex flex-col gap-3" data-spenders>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="usage-spenders" class="text-sm font-semibold tracking-label text-text-muted uppercase">
      Biggest spenders
    </h2>
    <Segmented {options} bind:value={kind} label="Rank by" hook="data-spender-kind" />
  </div>
  {#if rows.length === 0}
    <EmptyState text="Nothing to rank in this period." />
  {:else}
    <ol class="divide-y divide-border">
      {#each rows as row (row.key)}
        {@const target = opens(row)}
        <li data-spender-row data-clickable={target ? 'true' : 'false'}>
          {#if target}
            <button
              type="button"
              class="hud-row w-full justify-between gap-4"
              onclick={() => void openSession(target)}>{@render content(row)}</button
            >
          {:else}
            <div class="flex min-h-[var(--size-hit)] items-center justify-between gap-4 px-3 py-2">
              {@render content(row)}
            </div>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
