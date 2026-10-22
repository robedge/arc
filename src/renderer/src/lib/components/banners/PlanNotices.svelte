<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import type { ProviderId } from '@shared/types/provider'
  import type { PlanNotice } from '@shared/types/usage'
  import { formatResetTime } from '../../format/time'
  import { planUsage } from '../../stores/plan-usage.svelte'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    /** Fixed notices for the Design Preview, which must not touch the store or IPC. */
    preview?: PlanNotice[]
  }

  let { preview }: Props = $props()

  const notices = $derived(preview ?? planUsage.notices)

  /** "5h" becomes "5-hour" and "Weekly" becomes "weekly". */
  function limitWords(n: PlanNotice): string {
    const label = n.label ?? n.windowId
    const hours = /^(\d+)h$/i.exec(label)
    return hours ? `${hours[1]}-hour` : label.toLowerCase()
  }

  function name(n: PlanNotice): string {
    return providerName(n.provider as ProviderId)
  }
</script>

{#each notices as n (n.key)}
  <Banner
    kind={n.threshold >= 95 ? 'error' : 'warning'}
    role={n.threshold >= 95 ? 'alert' : 'status'}
    class="mx-3 mt-3 mb-0"
  >
    <p data-plan-notice="{n.provider}:{n.windowId}:{n.threshold}">
      {name(n)}'s {limitWords(n)} limit is at {n.threshold}%.{n.resetsAt !== null
        ? ` It resets at ${formatResetTime(n.resetsAt)}.`
        : ''}
    </p>
    {#snippet actions()}
      <Button
        ariaLabel="Dismiss {name(n)} {limitWords(n)} limit notice"
        onclick={() => {
          if (!preview) void planUsage.dismissNotice(n.key)
        }}>Dismiss</Button
      >
    {/snippet}
  </Banner>
{/each}
