<script lang="ts">
  import { ui } from '../../stores/ui.svelte'
  import Button from '../ui/Button.svelte'
  import Panel from '../ui/Panel.svelte'
  import AgentLoadSettings from './AgentLoadSettings.svelte'
  import PluginsSettings from './PluginsSettings.svelte'
  import ProvidersSettings from './ProvidersSettings.svelte'

  const pages = [
    { id: 'providers', label: 'Providers' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'agent-load', label: 'Agent loading' }
  ] as const

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented || ui.dialog) return
    event.preventDefault()
    ui.closeSettings()
  }
</script>

<svelte:window {onkeydown} />

<main
  class="grid min-h-0 flex-1 grid-cols-[var(--size-sidebar)_minmax(0,1fr)] gap-3 p-3"
  data-settings
>
  <Panel as="nav" aria-label="Settings" class="min-h-0">
    <div class="flex flex-col gap-2 p-3">
      <Button onclick={() => ui.closeSettings()}>Back</Button>
      <ul class="flex flex-col gap-1">
        {#each pages as p (p.id)}
          <li>
            <button
              type="button"
              class="hud-row w-full"
              data-selected={ui.settingsPage === p.id ? 'true' : 'false'}
              aria-current={ui.settingsPage === p.id ? 'page' : undefined}
              onclick={() => (ui.settingsPage = p.id)}>{p.label}</button
            >
          </li>
        {/each}
      </ul>
    </div>
  </Panel>
  <Panel as="div" scroll class="min-h-0">
    <div class="p-4">
      {#if ui.settingsPage === 'providers'}<ProvidersSettings
        />{:else if ui.settingsPage === 'plugins'}<PluginsSettings />{:else}<AgentLoadSettings
        />{/if}
    </div>
  </Panel>
</main>
