<script lang="ts">
  import type { CliStatus } from '@shared/types/session'
  import { providers } from '../../stores/providers.svelte'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    /** Overrides the live status (Design Preview). */
    status?: CliStatus | null
  }

  let { status: override }: Props = $props()
  const status = $derived(override ?? providers.claude ?? null)
</script>

{#if status && status.state !== 'ok'}
  <Banner kind={status.state === 'error' ? 'error' : 'warning'}>
    <p>{status.message}</p>
    {#snippet actions()}
      <Button busy={providers.busy.claude} onclick={() => void providers.check('claude')}
        >Retry</Button
      >
    {/snippet}
  </Banner>
{/if}
