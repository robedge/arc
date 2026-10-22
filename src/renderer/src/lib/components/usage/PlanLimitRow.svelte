<script lang="ts">
  import type { PlanLimit } from '@shared/types/usage'
  import { formatAsOf, formatResetTime } from '../../format/time'
  import { limitSeverity } from '../../usage/derive'
  import Icon from '../ui/Icon.svelte'

  interface Props {
    limit: PlanLimit
    now?: number
  }

  let { limit, now = Date.now() }: Props = $props()

  const severity = $derived(limit.stale ? 'ok' : limitSeverity(limit.usedPercent))
  const value = $derived(limit.stale ? 'Reset' : `${Math.round(limit.usedPercent)}%`)
  const meta = $derived(
    [
      limit.resetsAt !== null && !limit.stale
        ? `Resets at ${formatResetTime(limit.resetsAt, now)}`
        : null,
      formatAsOf(limit.observedAt)
    ]
      .filter((part) => part !== null)
      .join(' · ')
  )
</script>

<li
  class="flex flex-col gap-0.5 py-1.5"
  data-plan-limit="{limit.provider}:{limit.windowId}"
  data-severity={severity}
>
  <div class="flex items-baseline justify-between gap-4">
    <span class="text-text">{limit.label}</span>
    <span
      class="inline-flex items-center gap-1 tabular-nums {severity === 'critical'
        ? 'text-danger'
        : severity === 'warn'
          ? 'text-attention'
          : 'text-text-bright'}"
    >
      {#if severity !== 'ok'}
        <Icon name={severity === 'critical' ? 'error' : 'warning'} size={14} />
        <span class="sr-only">{severity === 'critical' ? 'critical' : 'warning'}</span>
      {/if}
      {value}
    </span>
  </div>
  <div class="text-xs text-text-muted tabular-nums">
    {meta}
  </div>
</li>
