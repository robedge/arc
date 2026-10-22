<script lang="ts">
  import type { ProviderPlan } from '@shared/types/usage'
  import PlanLimitRow from './PlanLimitRow.svelte'
  import { providerText } from './labels'

  interface Props {
    plans: readonly ProviderPlan[]
  }

  let { plans }: Props = $props()

  function stateText(plan: ProviderPlan): string | null {
    if (plan.limits.length > 0) return null
    return plan.state === 'waiting' ? 'Waiting for first use' : 'Not reported'
  }
</script>

{#if plans.length > 0}
  <section aria-labelledby="usage-plan-limits" class="flex flex-col gap-2" data-plan-limits>
    <h2
      id="usage-plan-limits"
      class="text-sm font-semibold tracking-label text-text-muted uppercase"
    >
      Plan limits
    </h2>
    <div class="grid gap-4 sm:grid-cols-2">
      {#each plans as plan (plan.provider)}
        <div data-plan-provider={plan.provider}>
          <h3 class="text-sm text-text-bright">{providerText(plan.provider)}</h3>
          {#if stateText(plan)}
            <p class="py-1.5 text-sm text-text-muted">{stateText(plan)}</p>
          {:else}
            <ul class="divide-y divide-border">
              {#each plan.limits as limit (limit.windowId)}
                <PlanLimitRow {limit} />
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}
