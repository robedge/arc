<script lang="ts">
  import {
    voiceErrorMessages,
    voiceModels,
    type VoiceModelsStore
  } from '../../stores/voice-models.svelte'
  import Button from '../ui/Button.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import ErrorText from '../ui/ErrorText.svelte'

  interface Props {
    /** Design Preview passes a seeded store. */
    store?: VoiceModelsStore
  }

  let { store = voiceModels }: Props = $props()
  let confirming = $state(false)

  function confirm(): void {
    confirming = false
    void store.download()
  }
</script>

{#if store.hasMissing}
  <div class="flex w-full flex-col gap-2" data-voice-models-prompt>
    {#if store.error}
      <ErrorText message={voiceErrorMessages[store.error]} />
      <Button variant="primary" onclick={() => void store.download()}>Retry</Button>
    {/if}
    {#if store.isDownloading}
      <div class="flex flex-col gap-1">
        <p class="text-xs text-text-muted">Downloading voice models... {store.percent}%</p>
        <div
          role="progressbar"
          aria-label="Voice model download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={store.percent}
          class="h-2 w-full overflow-hidden rounded-pill bg-surface-raised"
        >
          <div class="h-full bg-accent" style:width="{store.percent}%"></div>
        </div>
      </div>
    {:else if !store.error}
      <Button variant="primary" onclick={() => (confirming = true)}
        >Download voice models (about {store.totalMb} MB)</Button
      >
    {/if}
  </div>
{/if}
{#if confirming}
  <ConfirmDialog
    title="Download voice models?"
    body="Arc will download about {store.totalMb} MB of voice models once. They stay on this Mac."
    confirmLabel="Download"
    confirmVariant="primary"
    onconfirm={confirm}
    oncancel={() => (confirming = false)}
  />
{/if}
