<script lang="ts">
  import type { RangeTotals } from '@shared/types/usage'
  import TokenCount from '../ui/TokenCount.svelte'
  import UsageSummary from './UsageSummary.svelte'
  import { providerModelText, providerText } from './labels'

  interface Props {
    totals: RangeTotals
  }

  let { totals }: Props = $props()

  const byProvider = $derived(
    Object.fromEntries(
      totals.byProvider.filter((r) => !r.notReported).map((r) => [r.provider, r.tokens])
    )
  )
</script>

<section aria-labelledby="usage-totals" class="flex flex-col gap-3" data-usage-totals>
  <h2 id="usage-totals" class="text-sm font-semibold tracking-label text-text-muted uppercase">
    Tokens used
  </h2>
  <p class="text-3xl text-text-bright" data-range-total>
    <TokenCount value={totals.total.total} />
  </p>
  <UsageSummary totals={totals.total} {byProvider} />
  <div class="grid gap-4 sm:grid-cols-2">
    <div>
      <h3 class="text-sm text-text-muted">By provider</h3>
      <ul class="divide-y divide-border">
        {#each totals.byProvider as row (row.provider)}
          <li class="flex justify-between gap-4 py-1.5" data-total-provider={row.provider}>
            {#if row.notReported}
              <span>{providerText(row.provider)} · <TokenCount value={null} notReported /></span>
            {:else}
              <span>{providerText(row.provider)}</span>
              <TokenCount value={row.tokens.total} />
            {/if}
          </li>
        {/each}
      </ul>
    </div>
    <div>
      <h3 class="text-sm text-text-muted">By model</h3>
      <ul class="divide-y divide-border">
        {#each totals.byModel as row (`${row.provider}:${row.model}`)}
          <li
            class="flex justify-between gap-4 py-1.5"
            data-total-model="{row.provider}:{row.model}"
          >
            <span>{providerModelText(row.provider, row.model)}</span>
            <TokenCount value={row.tokens.total} />
          </li>
        {/each}
      </ul>
    </div>
  </div>
  {#if totals.planCheck.total > 0}
    <p class="flex justify-between gap-4 text-sm text-text-muted" data-plan-check>
      <span>Plan check (included above)</span>
      <TokenCount value={totals.planCheck.total} />
    </p>
  {/if}
</section>
