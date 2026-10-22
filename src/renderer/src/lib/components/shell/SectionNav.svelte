<script lang="ts">
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { SECTION_SESSIONS, ui } from '../../stores/ui.svelte'
  import { leaveGuard } from '../../stores/leave-guard.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import Menu from '../ui/Menu.svelte'
  import MenuItem from '../ui/MenuItem.svelte'
  import Panel from '../ui/Panel.svelte'

  interface Props {
    /** Tabs and Add Section are inert (the linked knowledge folder is missing). */
    disabled?: boolean
    /** The tab to show as selected; defaults to the store's active section. */
    activeId?: string | null
  }

  let { disabled = false, activeId }: Props = $props()

  let menuSectionId = $state<string | null>(null)

  function closeMenu(): void {
    menuSectionId = null
  }

  function toggleMenu(id: string): void {
    menuSectionId = menuSectionId === id ? null : id
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (menuSectionId === null) return
    const target = event.target
    if (target instanceof Element && target.closest('[data-section-menu-root]')) return
    closeMenu()
  }

  function choose(kind: 'section-rename' | 'section-delete', sectionId: string): void {
    // The menu item unmounts with the menu: park focus on its trigger so the dialog restores it on close.
    document.querySelector<HTMLElement>('[data-section-menu-button][aria-expanded="true"]')?.focus()
    closeMenu()
    ui.openDialog({ kind, sectionId })
  }

  function onmenukeydown(event: KeyboardEvent): void {
    const root = (event.currentTarget as HTMLElement).closest<HTMLElement>(
      '[data-section-menu-root]'
    )
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      root?.querySelector<HTMLElement>('[data-section-menu-button]')?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(root?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    items.at(next % items.length)?.focus()
  }

  const ordered = $derived(
    [...groupDetail.sections].sort(
      (a, b) => Number(b.builtIn) - Number(a.builtIn) || a.sortOrder - b.sortOrder
    )
  )
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<Panel as="div" class="px-5">
  <div class="flex flex-wrap items-center gap-1">
    <div role="tablist" aria-label="Sections" class="flex flex-wrap items-center gap-1">
      <button
        type="button"
        role="tab"
        aria-selected={(activeId ?? ui.activeSectionId) === SECTION_SESSIONS}
        {disabled}
        onclick={() => void leaveGuard.selectSection(SECTION_SESSIONS)}
        class="hud-tab"
      >
        Sessions
      </button>
      {#each ordered as section (section.id)}
        {@const active = (activeId ?? ui.activeSectionId) === section.id}
        <div class="relative flex items-center" data-section-menu-root>
          <button
            type="button"
            role="tab"
            aria-selected={active}
            {disabled}
            onclick={() => void leaveGuard.selectSection(section.id)}
            class="hud-tab"
          >
            {section.name}
          </button>
          {#if !section.builtIn}
            <IconButton
              data-section-menu-button
              label="Section options"
              icon="more"
              variant="secondary"
              {disabled}
              aria-haspopup="menu"
              aria-expanded={menuSectionId === section.id}
              onclick={() => toggleMenu(section.id)}
            />
            {#if menuSectionId === section.id}
              <Menu label="Section options" class="left-0" onkeydown={onmenukeydown}>
                <MenuItem onclick={() => choose('section-rename', section.id)}>Rename</MenuItem>
                <MenuItem danger onclick={() => choose('section-delete', section.id)}>
                  Delete
                </MenuItem>
              </Menu>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
    <button
      type="button"
      {disabled}
      onclick={() => ui.openDialog({ kind: 'section-create' })}
      class="hud-tab text-accent"
    >
      Add Section
    </button>
  </div>
</Panel>
