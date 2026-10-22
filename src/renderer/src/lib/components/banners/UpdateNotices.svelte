<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import { PROVIDER_IDS, type ProviderId, type ProviderStatus } from '@shared/types/provider'
  import { providers } from '../../stores/providers.svelte'
  import { ui } from '../../stores/ui.svelte'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'

  interface Props {
    /** Fixed statuses for the Design Preview, which must not touch the store or IPC. */
    preview?: Partial<Record<ProviderId, ProviderStatus>>
  }

  let { preview }: Props = $props()

  // One notice per provider, so each is dismissed for its own version.
  const notices = $derived(
    PROVIDER_IDS.flatMap((id) => {
      const s = (preview ?? providers.statuses)[id]
      return s?.updateAvailable && !s.updateDismissed && s.latestVersion && s.updateCommand
        ? [{ id, version: s.latestVersion, command: s.updateCommand }]
        : []
    })
  )

  let copiedId = $state<ProviderId | null>(null)

  async function copy(id: ProviderId, command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command)
      copiedId = id
      setTimeout(() => (copiedId = copiedId === id ? null : copiedId), 1500)
    } catch {
      // The command is shown in the notice; the Providers page offers it again.
    }
  }
</script>

{#each notices as n (n.id)}
  <Banner kind="info" class="mx-3 mt-3 mb-0">
    <p data-update-notice={n.id}>
      {providerName(n.id)}
      {n.version} is available. Run <code class="font-mono">{n.command}</code> in Terminal.
    </p>
    {#snippet actions()}
      <Button ariaLabel="Copy {n.command}" onclick={() => void copy(n.id, n.command)}>
        {copiedId === n.id ? 'Copied' : 'Copy'}
      </Button>
      {#if ui.view !== 'settings'}
        <Button onclick={() => ui.openSettings()}>Open Settings</Button>
      {/if}
      <Button
        ariaLabel="Dismiss {providerName(n.id)} update notice"
        onclick={() => {
          if (!preview) void providers.dismissUpdate(n.id, n.version)
        }}>Dismiss</Button
      >
    {/snippet}
  </Banner>
{/each}
