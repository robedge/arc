<script lang="ts">
  // Full-width window drag bar; the macOS traffic lights sit inside it. Interactive children must use no-drag.
  import { ui } from '../../stores/ui.svelte'
  import IconButton from './IconButton.svelte'
  import PlanMeters from './PlanMeters.svelte'
</script>

<header
  class="drag-region flex h-[var(--size-titlebar)] w-full shrink-0 items-center justify-end gap-2 border-b border-border bg-surface-bar px-3"
  data-titlebar
>
  <PlanMeters />
  <span class="no-drag shrink-0">
    <button
      type="button"
      class="inline-flex min-h-8 items-center rounded-control border border-border px-2.5 text-xs tracking-label text-text-muted uppercase hover:border-border-strong hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
      aria-pressed={ui.view === 'usage'}
      data-usage-button
      onclick={() => (ui.view === 'usage' ? ui.closeUsage() : ui.openUsage())}>Usage</button
    >
  </span>
  <span class="no-drag shrink-0">
    <IconButton
      label="Settings"
      icon="settings"
      compact
      aria-pressed={ui.view === 'settings'}
      onclick={() => (ui.view === 'settings' ? ui.closeSettings() : ui.openSettings())}
    />
  </span>
</header>
