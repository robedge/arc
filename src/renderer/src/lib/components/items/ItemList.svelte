<script lang="ts">
  import type { ItemSummary } from '@shared/types/item'

  interface Props {
    items: ItemSummary[]
    selectedId: string | null
    onselect: (id: string) => void
  }

  /** Above this many items, subfolder groups start collapsed. */
  const COLLAPSE_ABOVE = 30

  let { items, selectedId, onselect }: Props = $props()

  const topLevel = $derived(items.filter((i) => !i.folder))
  const groups = $derived.by(() => {
    const byFolder: Record<string, ItemSummary[]> = {}
    for (const item of items) {
      if (!item.folder) continue
      ;(byFolder[item.folder] ??= []).push(item)
    }
    return Object.entries(byFolder)
      .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
      .map(([folder, groupItems]) => ({ folder, items: groupItems }))
  })

  // Folders the user toggled; everything else follows the default (expanded unless the list is big).
  let toggled = $state<Record<string, boolean>>({})
  const collapsedByDefault = $derived(items.length > COLLAPSE_ABOVE)

  function isOpen(folder: string, groupItems: ItemSummary[]): boolean {
    if (folder in toggled) return toggled[folder] === true
    if (groupItems.some((i) => i.id === selectedId)) return true
    return !collapsedByDefault
  }

  function toggle(folder: string, groupItems: ItemSummary[]): void {
    toggled[folder] = !isOpen(folder, groupItems)
  }
</script>

{#snippet row(item: ItemSummary)}
  <li>
    <button
      type="button"
      aria-current={item.id === selectedId ? 'true' : undefined}
      onclick={() => onselect(item.id)}
      data-selected={item.id === selectedId ? 'true' : 'false'}
      class="hud-row w-full flex-col items-start! justify-center"
    >
      <span class="truncate font-mono text-sm text-text">{item.title}</span>
      {#if item.description}
        <span class="truncate text-xs text-text-muted">{item.description}</span>
      {/if}
    </button>
  </li>
{/snippet}

<ul aria-label="Items" class="flex flex-col gap-1">
  {#each topLevel as item (item.id)}
    {@render row(item)}
  {/each}
  {#each groups as group (group.folder)}
    {@const open = isOpen(group.folder, group.items)}
    <li role="presentation" class="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onclick={() => toggle(group.folder, group.items)}
        class="flex w-full items-center gap-2 px-1 py-1 text-left text-xs tracking-title text-text-muted uppercase hover:text-text"
      >
        <span aria-hidden="true" class="font-mono">{open ? '▾' : '▸'}</span>
        <span class="truncate font-mono normal-case">{group.folder}</span>
        <span aria-hidden="true" class="ml-auto font-mono">{group.items.length}</span>
      </button>
      {#if open}
        <ul aria-label={group.folder} class="flex flex-col gap-1 pl-3">
          {#each group.items as item (item.id)}
            {@render row(item)}
          {/each}
        </ul>
      {/if}
    </li>
  {/each}
</ul>
