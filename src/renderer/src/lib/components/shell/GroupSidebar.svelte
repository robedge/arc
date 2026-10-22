<script lang="ts">
  import { groups } from '../../stores/groups.svelte'
  import { sessionsList } from '../../stores/sessions-list.svelte'
  import { ui } from '../../stores/ui.svelte'
  import { leaveGuard } from '../../stores/leave-guard.svelte'
  import Button from '../ui/Button.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import Menu from '../ui/Menu.svelte'
  import MenuItem from '../ui/MenuItem.svelte'
  import Panel from '../ui/Panel.svelte'
  import Wordmark from '../ui/Wordmark.svelte'

  let menuGroupId = $state<string | null>(null)

  function closeMenu(): void {
    menuGroupId = null
  }

  function toggleMenu(id: string): void {
    menuGroupId = menuGroupId === id ? null : id
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (menuGroupId === null) return
    const target = event.target
    if (target instanceof Element && target.closest('[data-group-menu-root]')) return
    closeMenu()
  }

  function choose(kind: 'group-rename' | 'group-delete', groupId: string): void {
    // The menu item unmounts with the menu: park focus on its trigger so the dialog restores it on close.
    document.querySelector<HTMLElement>('[data-group-menu-button][aria-expanded="true"]')?.focus()
    closeMenu()
    ui.openDialog({ kind, groupId })
  }

  function onmenukeydown(event: KeyboardEvent): void {
    const root = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-group-menu-root]')
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      root?.querySelector<HTMLElement>('[data-group-menu-button]')?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(root?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    items.at(next % items.length)?.focus()
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<Panel as="nav" aria-label="Groups" scroll class="h-full">
  {#snippet header()}
    <div class="pb-3">
      <h1><Wordmark /></h1>
    </div>
    <div class="pb-3">
      <Button variant="primary" onclick={() => ui.openDialog({ kind: 'group-create' })}>
        New Group
      </Button>
    </div>
  {/snippet}
  <ul class="flex flex-col gap-1 p-3">
    {#each groups.list as group (group.id)}
      <li class="relative flex items-center gap-1" data-group-menu-root>
        <button
          type="button"
          aria-current={ui.selectedGroupId === group.id ? 'true' : undefined}
          data-selected={ui.selectedGroupId === group.id ? 'true' : 'false'}
          onclick={() => void leaveGuard.selectGroup(group.id)}
          class="hud-row min-w-0 flex-1"
        >
          <span class="truncate">{group.name}</span>
          {#if sessionsList.hasAttention(group.id)}
            <span
              role="img"
              aria-label="Needs attention"
              data-attention-dot
              class="ml-auto size-2 shrink-0 rounded-full bg-attention shadow-[var(--shadow-glow-attention)]"
            ></span>
          {/if}
        </button>
        <IconButton
          data-group-menu-button
          label="Group options"
          icon="more"
          aria-haspopup="menu"
          aria-expanded={menuGroupId === group.id}
          onclick={() => toggleMenu(group.id)}
        />
        {#if menuGroupId === group.id}
          <Menu label="Group options" class="right-0" onkeydown={onmenukeydown}>
            <MenuItem onclick={() => choose('group-rename', group.id)}>Rename</MenuItem>
            <MenuItem danger onclick={() => choose('group-delete', group.id)}>
              Delete Group
            </MenuItem>
          </Menu>
        {/if}
      </li>
    {/each}
  </ul>
</Panel>
