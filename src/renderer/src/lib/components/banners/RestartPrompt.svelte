<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import { PROVIDER_IDS, type ProviderId, type ProviderStatus } from '@shared/types/provider'
  import { providers } from '../../stores/providers.svelte'
  import Button from '../ui/Button.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    /** Fixed statuses for the Design Preview, which must not touch the store or IPC. */
    preview?: Partial<Record<ProviderId, ProviderStatus>>
    /** Design Preview only: Later closes the sample. */
    onlater?: () => void
  }

  let { preview, onlater }: Props = $props()

  const pending = $derived(
    PROVIDER_IDS.find((id) => {
      const s = (preview ?? providers.statuses)[id]
      return s?.restartRequired && (preview || !providers.restartDeferred[id])
    })
  )
  const reason = $derived(pending ? (preview ?? providers.statuses)[pending]?.restartReason : '')

  function later(): void {
    if (pending && !preview) providers.deferRestart(pending)
    onlater?.()
  }

  function restart(): void {
    if (!preview) void window.harness.invoke('app:relaunch', {})
  }
</script>

{#if pending}
  <Modal
    title="Restart Arc to finish updating {providerName(pending)}"
    size="md"
    onsubmit={restart}
    oncancel={later}
  >
    {#if reason}<p class="text-sm text-text">{reason}</p>{/if}
    <div class="flex justify-end gap-2">
      <Button onclick={later}>Later</Button>
      <Button type="submit" variant="primary">Restart now</Button>
    </div>
  </Modal>
{/if}
