<script lang="ts">
  import { exactTokens, formatTokens } from '../../format/tokens'

  interface Props {
    /** Null means the agent ran before usage was recorded. */
    value: number | null
    /** With a null value: the provider carries no token counts ("Not reported"), not a missed record. */
    notReported?: boolean
    /** Unit word shown after the number, for example "tokens". */
    suffix?: string
    class?: string
  }

  let { value, notReported = false, suffix, class: klass = '' }: Props = $props()

  const exact = $derived(value === null ? null : exactTokens(value))
</script>

{#if value === null}
  <span class="text-text-muted {klass}" data-token-count
    >{notReported ? 'Not reported' : 'Not recorded'}</span
  >
{:else}
  <span
    class="normal-case tabular-nums {klass}"
    title={`${exact} tokens`}
    aria-label={`${exact} tokens`}
    data-token-count
    data-tokens={value}>{formatTokens(value)}{suffix ? ` ${suffix}` : ''}</span
  >
{/if}
