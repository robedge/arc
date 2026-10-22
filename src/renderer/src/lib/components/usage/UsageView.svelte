<script lang="ts">
  import { onMount } from 'svelte'
  import { ui } from '../../stores/ui.svelte'
  import { usage } from '../../stores/usage.svelte'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Panel from '../ui/Panel.svelte'
  import DailyChart from './DailyChart.svelte'
  import PlanLimitsSection from './PlanLimitsSection.svelte'
  import RangePicker from './RangePicker.svelte'
  import SuggestionsList from './SuggestionsList.svelte'
  import SpendersList from './SpendersList.svelte'
  import UsageTotals from './UsageTotals.svelte'

  const report = $derived(usage.report)

  onMount(() => {
    void usage.loadReport(usage.range)
  })

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || ui.dialog) return
    event.preventDefault()
    ui.closeUsage()
  }
</script>

<svelte:window {onkeydown} />

<main class="flex min-h-0 flex-1 flex-col p-3" data-usage-view>
  <Panel as="div" scroll class="min-h-0 flex-1">
    <div class="flex flex-col gap-6 p-4">
      <header class="flex flex-wrap items-center gap-3">
        <Button onclick={() => ui.closeUsage()}>Back</Button>
        <h1 class="font-display text-xl text-text-bright">Usage</h1>
        <span class="ml-auto">
          <RangePicker
            bind:value={usage.range}
            onchange={(range) => void usage.loadReport(range)}
          />
        </span>
      </header>

      {#if report}
        <PlanLimitsSection plans={report.plans} />
        {#if report.totals.total.total === 0 && !report.totals.byProvider.some((r) => r.notReported)}
          <EmptyState text="No usage in this period." />
        {:else}
          <UsageTotals totals={report.totals} />
          <DailyChart daily={report.daily} range={report.range} total={report.totals.total.total} />
          <SpendersList spenders={report.spenders} bind:kind={usage.spenderKind} />
        {/if}
        <SuggestionsList
          level={2}
          showSessionLink
          suggestions={[...report.suggestions].sort((a, b) => b.createdAt - a.createdAt)}
          emptyText="No suggestions in this period."
          ondismiss={(id) => void usage.dismissSuggestion(id)}
        />
      {:else}
        <p class="text-sm text-text-muted" role="status">Loading usage…</p>
      {/if}
    </div>
  </Panel>
</main>
