<script lang="ts">
  import { onMount } from 'svelte'
  import { settings } from '../../stores/settings.svelte'
  import SkipApprovalsDialog from '../sessions/SkipApprovalsDialog.svelte'
  import Toggle from '../ui/Toggle.svelte'

  interface Props {
    /** Design Preview: a fixed value, never loaded or saved. */
    preview?: boolean
  }

  let { preview = false }: Props = $props()

  const stored = $derived(
    preview ? false : (settings.values?.['approvals.skipAllByDefault'] ?? false)
  )
  let checked = $derived(stored)
  let confirming = $state(false)

  async function save(value: boolean): Promise<void> {
    if (preview) return
    await settings.save({ 'approvals.skipAllByDefault': value })
    // A failed save leaves the stored value as it was: show that.
    checked = stored
  }

  function onchange(): void {
    if (checked) {
      // Turning on needs the warning first: the switch stays off until the user confirms.
      checked = false
      confirming = true
    } else {
      void save(false)
    }
  }

  async function confirm(): Promise<void> {
    confirming = false
    checked = true
    await save(true)
  }

  onMount(() => {
    if (!preview) void settings.load()
  })
</script>

<section aria-labelledby="approvals-title" class="flex flex-col gap-3" data-approvals-settings>
  <h2
    id="approvals-title"
    class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
  >
    Approvals
  </h2>
  <div class="flex flex-col gap-1">
    <Toggle
      id="skip-approvals-default"
      label="Skip all approvals by default"
      bind:checked
      error={preview ? null : settings.error}
      {onchange}
    />
    <p class="text-xs text-text-muted">
      When on, every new session starts with Skip all approvals on. Each session can still turn it
      off, and Arc still asks before pushing a branch or opening or merging a pull request.
    </p>
  </div>
</section>
{#if confirming}
  <SkipApprovalsDialog
    scope="default"
    onconfirm={() => void confirm()}
    oncancel={() => (confirming = false)}
  />
{/if}
