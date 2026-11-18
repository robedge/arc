<script lang="ts">
  import { onMount } from 'svelte'
  import {
    percentOf,
    voiceModelNames,
    voiceModels,
    type VoiceModelRow,
    type VoiceModelsStore
  } from '../../stores/voice-models.svelte'
  import { KOKORO_VOICES, type KokoroVoiceId, type VoiceSpeakPolicy } from '@shared/types/voice'
  import { nova } from '../../stores/nova.svelte'
  import { settings } from '../../stores/settings.svelte'
  import VoiceModelsPrompt from '../nova/VoiceModelsPrompt.svelte'
  import Button from '../ui/Button.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Radio from '../ui/Radio.svelte'
  import Select from '../ui/Select.svelte'

  interface Props {
    /** Design Preview: a seeded store, never loaded. */
    store?: VoiceModelsStore
    preview?: boolean
  }

  let { store = voiceModels, preview = false }: Props = $props()
  let deleting = $state(false)

  const voiceLabels: Record<KokoroVoiceId, string> = {
    af_heart: 'Heart (American, female)',
    af_bella: 'Bella (American, female)',
    af_nicole: 'Nicole (American, female)',
    am_michael: 'Michael (American, male)',
    bf_emma: 'Emma (British, female)',
    bm_george: 'George (British, male)'
  }
  const voiceOptions = KOKORO_VOICES.map((value) => ({ value, label: voiceLabels[value] }))

  const voiceId = $derived(settings.values?.['voice.voiceId'] ?? 'af_heart')
  const speed = $derived(settings.values?.['voice.speed'] ?? 1)
  let policy = $derived(settings.values?.['voice.speakPolicy'] ?? 'all')
  const savePolicy = (): void =>
    void settings.save({ 'voice.speakPolicy': policy as VoiceSpeakPolicy })
  const pauseOptions = [
    { value: '700', label: 'Short' },
    { value: '1000', label: 'Normal' },
    { value: '1500', label: 'Long' }
  ]
  let pause = $derived(String(settings.values?.['voice.endPauseMs'] ?? 1000))
  const savePause = (): void => void settings.save({ 'voice.endPauseMs': Number(pause) })
  // The slider shows the value while it moves; the setting is saved when it is released.
  let dragSpeed = $state<number | null>(null)

  const size = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`

  function stateLabel(row: VoiceModelRow): string {
    if (row.state === 'ready') return 'Ready'
    if (row.state === 'downloading') return `Downloading ${percentOf(row)}%`
    if (row.state === 'failed') return 'Failed'
    return 'Not downloaded'
  }

  async function remove(): Promise<void> {
    deleting = false
    await store.remove()
  }

  onMount(() => {
    if (preview) return
    void store.load()
    if (!settings.values) void settings.load()
  })
</script>

<section aria-labelledby="voice-title" class="flex flex-col gap-3" data-voice-settings>
  <h2
    id="voice-title"
    class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
  >
    Voice
  </h2>
  <ul class="flex flex-col gap-1">
    {#each store.models as row (row.id)}
      <li class="hud-row flex items-center justify-between gap-3" data-voice-model={row.id}>
        <span class="text-sm text-text">{voiceModelNames[row.kind]}</span>
        <span class="text-xs text-text-muted">{size(row.totalBytes)} · {stateLabel(row)}</span>
      </li>
    {/each}
  </ul>
  <VoiceModelsPrompt {store} />
  <div class="flex flex-col gap-3" data-voice-options>
    <div class="max-w-sm">
      <Select
        id="voice-voice"
        label="Voice"
        options={voiceOptions}
        bind:value={
          () => voiceId, (v) => void settings.save({ 'voice.voiceId': v as KokoroVoiceId })
        }
      />
    </div>
    <div class="flex max-w-sm flex-col gap-1">
      <label for="voice-speed" class="text-sm font-medium text-text">
        Speed <span class="text-text-muted" data-voice-speed-value
          >{(dragSpeed ?? speed).toFixed(2)}x</span
        >
      </label>
      <input
        id="voice-speed"
        type="range"
        min="0.7"
        max="1.3"
        step="0.05"
        value={speed}
        oninput={(e) => (dragSpeed = Number(e.currentTarget.value))}
        onchange={(e) => {
          dragSpeed = null
          void settings.save({ 'voice.speed': Number(e.currentTarget.value) })
        }}
        class="min-h-[var(--size-hit)] w-full cursor-pointer accent-accent focus:outline-none focus-visible:shadow-focus"
      />
    </div>
    <div>
      <Button
        disabled={!store.ttsReady || nova.previewing}
        busy={nova.previewing}
        onclick={() => nova.preview()}>Preview</Button
      >
    </div>
    <fieldset class="flex flex-col gap-1" aria-labelledby="voice-policy-title">
      <legend id="voice-policy-title" class="text-sm font-medium text-text">When Nova speaks</legend
      >
      <Radio
        id="voice-policy-all"
        name="voice-policy"
        label="Speak every answer"
        value="all"
        bind:group={policy}
        onchange={savePolicy}
      />
      <Radio
        id="voice-policy-spoken"
        name="voice-policy"
        label="Only answers to spoken questions"
        value="spoken-only"
        bind:group={policy}
        onchange={savePolicy}
      />
    </fieldset>
    <fieldset class="flex flex-col gap-1" aria-labelledby="voice-pause-title" data-voice-pause>
      <legend id="voice-pause-title" class="text-sm font-medium text-text"
        >Pause before Nova answers</legend
      >
      {#each pauseOptions as option (option.value)}
        <Radio
          id={`voice-pause-${option.value}`}
          name="voice-pause"
          label={option.label}
          value={option.value}
          bind:group={pause}
          onchange={savePause}
        />
      {/each}
      <p class="text-xs text-text-muted">Nova waits longer when you stop mid-sentence.</p>
    </fieldset>
    {#if settings.error}<ErrorText message={settings.error} />{/if}
  </div>
  {#if store.allReady}
    <div>
      <Button variant="danger" onclick={() => (deleting = true)}>Delete voice models</Button>
    </div>
  {/if}
</section>
{#if deleting}
  <ConfirmDialog
    title="Delete voice models?"
    body="Nova will stop speaking and listening until you download the models again."
    confirmLabel="Delete"
    onconfirm={() => void remove()}
    oncancel={() => (deleting = false)}
  />
{/if}
