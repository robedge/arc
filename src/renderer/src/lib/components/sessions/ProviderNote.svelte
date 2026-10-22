<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import { PROVIDER_TRAITS } from '@shared/provider-traits'
  import { PROVIDER_IDS, type ProviderId, type ProviderStatus } from '@shared/types/provider'
  import type { SessionHeader, WorkerView } from '@shared/types/session'
  import { providers } from '../../stores/providers.svelte'
  import { ui } from '../../stores/ui.svelte'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    header: SessionHeader
    workers: readonly WorkerView[]
    /** Overrides the live status of one provider (Design Preview). */
    status?: ProviderStatus
  }

  let { header, workers, status: override }: Props = $props()

  const claude = $derived(providers.statuses.claude)
  // Claude down already shows the blocking banner, so a note would repeat it.
  const claudeDown = $derived(claude !== undefined && claude.state !== 'ok')

  /** True when the brain, the Workers choice or any worker asks for this provider. */
  function uses(id: ProviderId): boolean {
    return (
      (header.brainRunningOn?.requestedProvider ?? header.brainRunningOn?.provider) === id ||
      (header.workers?.mode === 'provider' && header.workers.provider === id) ||
      (header.workers?.mode === 'model' && header.workers.model.provider === id) ||
      workers.some((w) => (w.runningOn?.requestedProvider ?? w.runningOn?.provider) === id)
    )
  }

  const notes = $derived(
    claudeDown
      ? []
      : PROVIDER_IDS.filter((id) => id !== 'claude' && uses(id)).flatMap((id) => {
          const status = override?.provider === id ? override : providers.statuses[id]
          if (
            status === undefined ||
            status.state === 'ok' ||
            providers.providerNoteDismissed[`${header.id}:${id}`] === status.state
          ) {
            return []
          }
          return [{ id, status }]
        })
  )

  function lead(id: ProviderId, state: string): string {
    const name = providerName(id)
    if (state === 'signed_out')
      return `${name} isn't signed in, so ${name} work runs on Claude for now.`
    if (state === 'missing')
      return `${name} isn't installed, so ${name} work runs on Claude for now.`
    return `${name} isn't available, so ${name} work runs on Claude for now.`
  }
  function detail(id: ProviderId, status: ProviderStatus): string {
    return (
      status.message ||
      (status.loginCommand ? `Run ${status.loginCommand} in Terminal.` : '') ||
      (status.state === 'signed_out' ? `Run ${PROVIDER_TRAITS[id].loginCommand} in Terminal.` : '')
    )
  }
</script>

{#each notes as { id, status } (id)}
  <Banner kind="info">
    <p>{lead(id, status.state)}</p>
    {#if detail(id, status)}<p class="text-text-muted">{detail(id, status)}</p>{/if}
    {#snippet actions()}
      <Button
        ariaLabel="Check {providerName(id)} again"
        busy={providers.busy[id]}
        onclick={() => void providers.check(id)}>Check again</Button
      >
      <Button ariaLabel="Open Settings on the Providers page" onclick={() => ui.openSettings()}
        >Open Settings</Button
      >
      <Button
        ariaLabel="Dismiss the {providerName(id)} note"
        onclick={() => providers.dismissProviderNote(header.id, id, status.state)}>Dismiss</Button
      >
    {/snippet}
  </Banner>
{/each}
