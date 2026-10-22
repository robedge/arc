<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import type { ProviderId } from '@shared/types/provider'
  import type { SessionUsage, TokenTotals } from '@shared/types/usage'
  import LiveMark from '../ui/LiveMark.svelte'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import TokenCount from '../ui/TokenCount.svelte'
  import { usage } from '../../stores/usage.svelte'
  import { sessionTotalGap } from '../../usage/derive'
  import SuggestionsList from '../usage/SuggestionsList.svelte'
  import UsageSummary from '../usage/UsageSummary.svelte'
  import SetupSplit from './SetupSplit.svelte'

  interface Props {
    id: string
    /** Null before the first snapshot. */
    snapshot: SessionUsage | null
    /** Placement classes, e.g. "right-0". */
    class?: string
    /** Pixels available below the chip; bounds the panel so it scrolls instead of being cut off. */
    maxHeight?: number
  }

  let { id, snapshot, class: klass = 'left-0', maxHeight }: Props = $props()

  const COLUMNS: readonly { key: keyof TokenTotals; label: string }[] = [
    { key: 'input', label: 'Input' },
    { key: 'cacheWrite', label: 'Cache write (cold)' },
    { key: 'cacheRead', label: 'Cache read (hit)' },
    { key: 'output', label: 'Output' },
    { key: 'total', label: 'Total' }
  ]

  const providers = $derived(
    snapshot ? (Object.entries(snapshot.byProvider) as [ProviderId, TokenTotals][]) : []
  )

  const gap = $derived(sessionTotalGap(snapshot))
  const notReportedNames = $derived((snapshot?.notReported ?? []).map(providerName).join(' and '))
  const inProgress = $derived(snapshot?.agents.some((a) => a.inFlight !== undefined) ?? false)

  const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`

  function setupLine(s: SessionUsage): string {
    // Arc's part as a share of the setup, the same measure the Setup overhead suggestion uses.
    const arc =
      s.arcSetupShare === null || !s.setupShare
        ? ''
        : ` (Arc's additions about ${pct(s.arcSetupShare / s.setupShare)} of it)`
    return `Setup: ${pct(s.setupShare ?? 0)} of this session${arc}`
  }

  function focusPanel(node: HTMLElement): void {
    node.focus()
  }
</script>

<div
  {id}
  role="dialog"
  tabindex="-1"
  aria-label="Token usage"
  use:focusPanel
  class="absolute top-full z-20 mt-1 max-h-[calc(100vh-8rem)] w-[min(44rem,calc(100vw-2rem))] overflow-x-auto overflow-y-auto rounded-hud border border-border-strong bg-surface-raised p-3 text-xs shadow-glow-accent focus:outline-none focus-visible:shadow-focus {klass}"
  style:max-height={maxHeight === undefined ? undefined : `${Math.max(maxHeight, 160)}px`}
  data-usage-panel
>
  {#if snapshot}
    <table class="w-full border-collapse tabular-nums">
      <caption class="pb-2 text-left tracking-label text-text-muted uppercase"
        >Tokens by agent</caption
      >
      <thead>
        <tr class="text-text-muted">
          <th scope="col" class="px-2 py-1 text-left font-normal">Agent</th>
          {#each COLUMNS as column (column.key)}
            <th scope="col" class="px-2 py-1 text-right font-normal">{column.label}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each snapshot.agents as agent (agent.agentKey)}
          <tr class="border-t border-border" data-usage-row={agent.agentKey}>
            <th scope="row" class="px-2 py-1 text-left font-normal text-text">
              <span class="flex items-center gap-1.5"
                >{agent.label}{#if agent.inFlight}<LiveMark />{/if}</span
              >
              <ProviderTag runningOn={{ provider: agent.provider, model: agent.model }} />
              {#if agent.recording === 'partial'}
                <span class="block text-text-muted" data-usage-partial
                  >Counted since Arc started recording</span
                >
              {/if}
            </th>
            {#if agent.tokens === null}
              <td colspan={COLUMNS.length} class="px-2 py-1 text-right"
                ><TokenCount value={null} notReported={agent.recording === 'not-reported'} /></td
              >
            {:else}
              {#each COLUMNS as column (column.key)}
                <td class="px-2 py-1 text-right text-text"
                  ><TokenCount value={agent.tokens[column.key]} /></td
                >
              {/each}
            {/if}
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr class="border-t border-border-strong font-semibold" data-usage-total>
          <th scope="row" class="px-2 py-1 text-left text-text-bright"
            ><span class="flex items-center gap-1.5"
              >Session total{#if inProgress}<LiveMark />{/if}</span
            ></th
          >
          {#if gap}
            <td colspan={COLUMNS.length} class="px-2 py-1 text-right"
              ><TokenCount value={null} notReported={gap === 'not-reported'} /></td
            >
          {:else}
            {#each COLUMNS as column (column.key)}
              <td class="px-2 py-1 text-right text-text-bright"
                ><TokenCount value={snapshot.total[column.key]} /></td
              >
            {/each}
          {/if}
        </tr>
      </tfoot>
    </table>
    {#if !gap}
      <UsageSummary class="mt-3" totals={snapshot.total} byProvider={snapshot.byProvider} />
    {/if}
    {#if providers.length > 0}
      <ul class="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label="Totals by provider">
        {#each providers as [provider, totals] (provider)}
          <li class="text-text" data-usage-provider-total={provider}>
            {providerName(provider)} · <TokenCount value={totals.total} />
          </li>
        {/each}
      </ul>
    {/if}
    {#if notReportedNames}
      <p class="mt-2 text-text-muted" data-usage-not-reported>
        {notReportedNames} doesn't report tokens; its agents aren't in these totals.
      </p>
    {/if}
    {#if snapshot.setupShare !== null}
      <p class="mt-2 text-text" data-setup-share>{setupLine(snapshot)}</p>
    {/if}
    <div class="mt-2 space-y-1" aria-label="Where the tokens go" role="group">
      {#each snapshot.agents.filter((a) => a.tokens !== null) as agent (agent.agentKey)}
        {@const t = agent.tokens as TokenTotals}
        {@const f = agent.inFlight}
        <details
          class="rounded-control border border-border px-2 py-1"
          data-usage-setup={agent.agentKey}
        >
          <summary
            class="cursor-pointer text-text-muted focus:outline-none focus-visible:shadow-focus"
            >{agent.label}: where the tokens go</summary
          >
          <div class="pt-1">
            <SetupSplit
              setup={agent.setup}
              inputTotal={t.input +
                t.cacheWrite +
                t.cacheRead -
                (f ? f.input + f.cacheWrite + f.cacheRead : 0)}
            />
          </div>
        </details>
      {/each}
    </div>
    <div class="mt-3">
      <SuggestionsList
        suggestions={snapshot.suggestions}
        ondismiss={(sid) => void usage.dismissSuggestion(sid)}
      />
    </div>
    {#if inProgress}
      <p class="mt-2 text-text-muted" data-usage-in-progress>
        Agents marked with a dot are mid-turn, so their numbers are still rising. The setup split,
        suggestions and the Usage page count saved turns only.
      </p>
    {/if}
    {#if snapshot.partial}
      <p class="mt-2 text-text-muted" data-usage-note>
        Some agents started before Arc began recording, so their totals are incomplete.
      </p>
    {/if}
  {:else}
    <p class="text-text-muted">No usage recorded yet.</p>
  {/if}
  <p class="mt-3 text-text-muted" data-usage-not-counted>
    Not counted: CLI runs an agent starts itself, for example <code>claude -p</code> from its shell.
  </p>
</div>
