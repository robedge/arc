<script lang="ts">
  import { onMount } from 'svelte'
  import { settings } from '../../stores/settings.svelte'
  import Toggle from '../ui/Toggle.svelte'

  interface Props {
    /** Design Preview: a fixed value, never loaded or saved. */
    preview?: boolean
  }

  let { preview = false }: Props = $props()

  const stored = $derived(preview ? true : (settings.values?.['knowledge.suggestOnFinish'] ?? true))
  let checked = $derived(stored)

  async function save(): Promise<void> {
    if (preview) return
    await settings.save({ 'knowledge.suggestOnFinish': checked })
    // A failed save leaves the stored value as it was: show that.
    checked = stored
  }

  onMount(() => {
    if (!preview) void settings.load()
  })
</script>

<section aria-labelledby="knowledge-title" class="flex flex-col gap-3" data-knowledge-settings>
  <h2
    id="knowledge-title"
    class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
  >
    Knowledge
  </h2>
  <div class="flex flex-col gap-1">
    <Toggle
      id="suggest-knowledge-updates"
      label="Suggest knowledge updates"
      bind:checked
      error={preview ? null : settings.error}
      onchange={() => void save()}
    />
    <p class="text-xs text-text-muted">
      When on, the brain may offer new and updated notes after it finishes a request. When off, it
      suggests only when you ask it in the chat. Suggestions already waiting stay.
    </p>
  </div>
</section>
