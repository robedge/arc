<script lang="ts">
  import { nova, type NovaState } from '../../stores/nova.svelte'
  import NovaFace from './NovaFace.svelte'
  import { onMount } from 'svelte'
  import { settings } from '../../stores/settings.svelte'
  import { voiceModels } from '../../stores/voice-models.svelte'
  import Banner from '../ui/Banner.svelte'
  import VoiceModelsPrompt from './VoiceModelsPrompt.svelte'
  import Button from '../ui/Button.svelte'
  import Panel from '../ui/Panel.svelte'

  interface Props {
    /** Design Preview: nothing is loaded. */
    preview?: boolean
  }

  let { preview = false }: Props = $props()

  onMount(() => {
    if (preview) return
    void voiceModels.load()
    if (!settings.values) void settings.load()
    return nova.attach()
  })

  const labels: Record<NovaState, string> = {
    idle: 'Idle',
    listening: 'Listening',
    thinking: 'Thinking',
    speaking: 'Speaking'
  }
</script>

<Panel brackets="diag" as="aside" aria-label="Nova" data-nova-panel class="h-full">
  <div class="flex h-full min-h-0 flex-col items-center gap-3 p-3">
    <div class="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden">
      <NovaFace {preview} exposePose={voiceModels.fake} />
    </div>
    <div class="flex flex-col items-center gap-1">
      <h2 class="font-display text-lg tracking-title text-text-bright uppercase">Nova</h2>
      <p
        class="text-xs font-semibold tracking-label text-accent uppercase"
        role="status"
        data-nova-state={nova.state}
        data-nova-last-spoken={voiceModels.fake ? nova.lastSpoken : undefined}
        data-nova-spoken-log={voiceModels.fake ? JSON.stringify(nova.spokenLog) : undefined}
      >
        {labels[nova.state]}
      </p>
    </div>
    {#if nova.preparing}
      <p class="text-sm text-text-muted" role="status" data-nova-preparing>Getting ready…</p>
    {/if}
    {#if nova.state === 'listening'}
      <div
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(nova.micLevel * 100)}
        class="h-1.5 w-full overflow-hidden rounded-full bg-surface-code"
        data-nova-level={nova.micLevel.toFixed(2)}
      >
        <div class="h-full bg-accent" style:width="{Math.round(nova.micLevel * 100)}%"></div>
      </div>
    {/if}
    <p
      class="min-h-[1.25rem] text-center text-sm text-text"
      aria-live={nova.hearing ? 'off' : 'polite'}
      aria-atomic="true"
      data-nova-transcript
    >
      {nova.transcript}
    </p>
    {#if nova.micNotice === 'denied'}
      <div class="w-full" data-nova-mic-denied>
        <Banner kind="warning">
          Arc can't hear you. Allow microphone access in System Settings &gt; Privacy &amp; Security
          &gt; Microphone.
          {#snippet actions()}
            <Button onclick={() => nova.openMicSettings()}>Open System Settings</Button>
          {/snippet}
        </Banner>
      </div>
    {:else if nova.micNotice === 'none'}
      <div class="w-full" data-nova-no-mic>
        <Banner kind="warning">No microphone found.</Banner>
      </div>
    {:else if nova.micNotice === 'failed'}
      <div class="w-full" data-nova-listen-failed>
        <Banner kind="warning">Nova couldn't start listening. Try again.</Banner>
      </div>
    {/if}
    {#if nova.modelMissing}
      <div class="w-full" data-nova-model-missing>
        <Banner kind="warning">Download the voice models to talk to Nova.</Banner>
      </div>
    {/if}
    {#if nova.sendError}
      <div class="w-full"><Banner kind="error">{nova.sendError}</Banner></div>
    {/if}
    {#if nova.ttsFailed}
      <div class="w-full" data-nova-tts-failed>
        <Banner kind="warning">Nova can't speak right now. Answers still appear in the chat.</Banner
        >
      </div>
    {/if}
    <VoiceModelsPrompt />
    <div class="flex flex-wrap items-center justify-center gap-2">
      {#if nova.conversation || nova.preparing}
        <Button onclick={() => nova.endConversation()}>End conversation</Button>
      {:else}
        <Button variant="primary" onclick={() => void nova.startConversation()}
          >Start conversation</Button
        >
      {/if}
      {#if nova.state === 'listening'}
        <Button onclick={() => nova.cancel()}>Cancel</Button>
      {/if}
    </div>
    <div class="flex flex-wrap items-center justify-center gap-2">
      <Button disabled={nova.state !== 'speaking'} onclick={() => nova.stop()}>Stop</Button>
      <Button pressed={nova.muted} onclick={() => void nova.setMuted(!nova.muted)}>Mute</Button>
      <Button onclick={() => nova.close()}>Close</Button>
    </div>
  </div>
</Panel>
