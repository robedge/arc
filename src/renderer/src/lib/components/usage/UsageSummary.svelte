<script lang="ts">
  import type { TokenTotals } from '@shared/types/usage'
  import { WEIGHTED_EXPLANATION, cacheShare, newTokens, weightedTotal } from '@shared/usage-weights'
  import TokenCount from '../ui/TokenCount.svelte'

  interface Props {
    /** The session's or range's four buckets and total. */
    totals: TokenTotals
    /** The same tokens per provider; each provider is weighted with its own ratios. */
    byProvider: Readonly<Record<string, TokenTotals | undefined>>
    class?: string
  }

  let { totals, byProvider, class: klass = '' }: Props = $props()

  const explanationId = $props.id()
  const share = $derived(cacheShare(totals))
  const weighted = $derived(Math.round(weightedTotal(byProvider)))
</script>

<div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 {klass}">
  <p class="text-text" data-usage-summary>
    New <TokenCount value={newTokens(totals)} /> · From cache
    <TokenCount value={totals.cacheRead} />{share === null ? '' : ` (${Math.round(share * 100)}%)`}
  </p>
  <!-- Title for hover; the screen-reader-only text carries the same explanation for assistive tech. -->
  <p
    class="text-text"
    title={WEIGHTED_EXPLANATION}
    aria-describedby={explanationId}
    data-usage-weighted
  >
    <span class="underline decoration-dotted underline-offset-2">Weighted ≈</span>
    <TokenCount value={weighted} />
    <span id={explanationId} class="sr-only">{WEIGHTED_EXPLANATION}</span>
  </p>
</div>
