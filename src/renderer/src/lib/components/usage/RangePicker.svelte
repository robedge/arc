<script lang="ts">
  import type { UsageRange } from '@shared/types/usage'
  import Segmented from './Segmented.svelte'

  interface Props {
    value: UsageRange
    onchange: (value: UsageRange) => void
  }

  let { value = $bindable(), onchange }: Props = $props()

  const options = [
    { value: 'today', label: 'Today' },
    { value: '7d', label: '7 days' },
    { value: '30d', label: '30 days' },
    { value: 'all', label: 'All time' }
  ] as const satisfies readonly { value: UsageRange; label: string }[]
</script>

<Segmented {options} bind:value label="Range" hook="data-range" {onchange} />
