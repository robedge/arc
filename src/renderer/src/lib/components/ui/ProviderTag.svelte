<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements'
  import { hasFallback, runningOnLabel } from '@shared/provider-label'
  import type { RunningOn } from '@shared/types/provider'

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    /** What the agent runs on. Absent only for data older than the provider field. */
    runningOn?: RunningOn
    /** The bare model name, shown as is when `runningOn` is missing. */
    model?: string
    /** Show a fallback's reason as visible text after the label, not only as a tooltip. */
    showReason?: boolean
  }

  let { runningOn, model, showReason = false, class: klass = '', ...rest }: Props = $props()

  const label = $derived(runningOn ? runningOnLabel(runningOn) : (model ?? ''))
  const reason = $derived(
    runningOn && hasFallback(runningOn) ? runningOn.fallbackReason : undefined
  )
</script>

<span class="font-mono text-xs text-text-muted {klass}" title={reason} data-provider-tag {...rest}
  >{label}{#if reason}{#if showReason}<span class="block break-words" data-provider-reason
        >{reason}</span
      >{:else}<span class="sr-only"> ({reason})</span>{/if}{/if}</span
>
