<script lang="ts">
  import type { PluginRow } from '@shared/types/plugins'
  import Button from '../ui/Button.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import Menu from '../ui/Menu.svelte'
  import MenuItem from '../ui/MenuItem.svelte'

  interface Props {
    plugin: PluginRow
    /** Which change is running on this row, if any. */
    busyKind?: 'update' | 'uninstall' | null
    /** Another change is running or Claude Code is unavailable: every action is disabled. */
    disabled?: boolean
    onupdate?: (plugin: PluginRow) => void
    onremove?: (plugin: PluginRow) => void
  }

  let { plugin, busyKind = null, disabled = false, onupdate, onremove }: Props = $props()

  let menuOpen = $state(false)
  let root: HTMLElement | undefined = $state()

  function trigger(): HTMLElement | null {
    return root?.querySelector<HTMLElement>('[data-plugin-menu-button]') ?? null
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (!menuOpen) return
    const target = event.target
    if (target instanceof Node && root?.contains(target)) return
    menuOpen = false
  }

  function onmenukeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    menuOpen = false
    trigger()?.focus()
  }

  function updateFromMenu(): void {
    trigger()?.focus()
    menuOpen = false
    onupdate?.(plugin)
  }

  function part(count: number, one: string, many: string): string | null {
    return count === 0 ? null : `${count} ${count === 1 ? one : many}`
  }

  const counts = $derived(
    [
      part(plugin.counts.commands, 'command', 'commands'),
      part(plugin.counts.skills, 'skill', 'skills'),
      part(plugin.counts.agents, 'agent', 'agents')
    ]
      .filter((p) => p !== null)
      .join(' · ') || 'No commands'
  )
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<li
  bind:this={root}
  aria-busy={busyKind ? 'true' : undefined}
  data-plugin={plugin.id}
  data-enabled={plugin.enabled ? 'true' : 'false'}
  class="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0 {plugin.enabled
    ? ''
    : 'opacity-60'}"
>
  <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h3 class="text-sm font-semibold text-text-bright">{plugin.name}</h3>
    <span class="font-mono text-xs text-text-muted">{plugin.version}</span>
    <span class="font-mono text-xs text-text-faint" title={plugin.source ?? plugin.marketplace}
      >{plugin.marketplace}</span
    >
  </div>
  {#if plugin.description}
    <p class="text-sm text-text-muted">{plugin.description}</p>
  {/if}
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <span class="text-text-muted" data-counts>{counts}</span>
    {#if !plugin.enabled}
      <span data-badge class="rounded-control border border-border px-1.5 text-text-muted"
        >Turned off in Claude Code</span
      >
    {/if}
    {#if plugin.updateAvailable}
      <span data-badge class="rounded-control border border-attention px-1.5 text-attention"
        >Update available: {plugin.updateAvailable}</span
      >
    {/if}
  </div>
  <div class="relative flex flex-wrap items-center gap-2 pt-1" data-plugin-actions>
    {#if plugin.updateAvailable}
      <Button
        variant="primary"
        ariaLabel="Update {plugin.name}"
        busy={busyKind === 'update'}
        disabled={disabled && busyKind !== 'update'}
        onclick={() => onupdate?.(plugin)}>Update</Button
      >
    {/if}
    <Button
      variant="danger"
      ariaLabel="Remove {plugin.name}"
      busy={busyKind === 'uninstall'}
      disabled={disabled && busyKind !== 'uninstall'}
      onclick={() => onremove?.(plugin)}>Remove</Button
    >
    {#if !plugin.updateAvailable}
      <!-- Update detection can miss, so Update stays reachable on every row without the badge. -->
      <IconButton
        data-plugin-menu-button
        label="More actions for {plugin.name}"
        icon="more"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        busy={busyKind === 'update'}
        disabled={disabled && busyKind !== 'update'}
        onclick={() => (menuOpen = !menuOpen)}
      />
      {#if menuOpen}
        <Menu label="More actions for {plugin.name}" class="left-0" onkeydown={onmenukeydown}>
          <MenuItem onclick={updateFromMenu}>Update</MenuItem>
        </Menu>
      {/if}
    {/if}
  </div>
</li>
