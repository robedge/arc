<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import type { Section } from '@shared/types/section'
  import { itemDraft } from '../../stores/item-draft.svelte'
  import { knowledge } from '../../stores/knowledge.svelte'
  import { ui } from '../../stores/ui.svelte'
  import { leaveGuard } from '../../stores/leave-guard.svelte'
  import { importFlow } from '../../stores/import-flow.svelte'
  import Button from '../ui/Button.svelte'
  import Panel from '../ui/Panel.svelte'
  import TextArea from '../ui/TextArea.svelte'
  import DropZone from '../ui/DropZone.svelte'
  import ItemDetail from '../items/ItemDetail.svelte'
  import ItemList from '../items/ItemList.svelte'
  import ChangedOnDiskBanner from '../banners/ChangedOnDiskBanner.svelte'
  import { messageFor } from '../../ipc/messages'
  import { toasts } from '../../stores/toasts.svelte'

  let { section, docs = false }: { section: Section; docs?: boolean } = $props()

  const newLabel = $derived(
    section.kind === 'notes'
      ? 'New Note'
      : section.kind === 'playbooks'
        ? 'New Playbook'
        : 'New Item'
  )
  const selected = $derived(knowledge.items.find((i) => i.id === ui.selectedItemId) ?? null)

  $effect(() => {
    void knowledge.load(section.id)
  })

  /** The open item vanished from disk: keep its text and banner even though the list lost it. */
  const orphan = $derived(
    selected === null && itemDraft.external === 'deleted' && itemDraft.itemId !== null
  )

  // Load the draft for the selected editable item; switching flushes the previous one.
  $effect(() => {
    const id = selected?.editable ? selected.id : orphan ? itemDraft.itemId : null
    const title = selected?.title ?? lastTitle
    untrack(() => void itemDraft.open(id, title))
  })

  // The deleted item is gone from the list, so remember its title for "Save as new".
  let lastTitle = 'Recovered item'
  $effect(() => {
    if (selected) {
      lastTitle = selected.title
      itemDraft.setTitle(selected.title)
    }
  })

  async function saveOrphanAsNew(): Promise<void> {
    const failure = await knowledge.saveDeletedAsNew(section.id, lastTitle)
    if (failure) toasts.show(messageFor(failure), 'error')
  }

  onDestroy(() => void itemDraft.open(null))
</script>

<DropZone
  ondrop={(paths) => void importFlow.drop(section.id, paths)}
  class="flex h-full min-h-0 flex-col"
>
  <div class="flex shrink-0 items-center justify-between py-2">
    <h3 class="font-display text-sm tracking-title text-text-muted uppercase">{section.name}</h3>
    <div class="flex gap-2">
      <Button onclick={() => void importFlow.pick(section.id)}>Import…</Button>
      {#if !docs}
        <Button
          variant="primary"
          onclick={() => ui.openDialog({ kind: 'item-create', sectionId: section.id })}
          >{newLabel}</Button
        >
      {/if}
    </div>
  </div>
  <div class="flex min-h-0 flex-1 gap-4">
    <Panel scroll class="w-64 shrink-0">
      <div class="p-2">
        <ItemList
          items={knowledge.items}
          selectedId={ui.selectedItemId}
          onselect={(id) => void leaveGuard.selectItem(id)}
        />
      </div>
    </Panel>
    <Panel scroll class="min-w-0 flex-1">
      <div class="flex h-full min-h-0 flex-col p-3">
        {#if selected}
          {#key selected.id}
            <ItemDetail item={selected} />
          {/key}
        {:else if orphan}
          <div class="flex flex-col gap-3">
            <ChangedOnDiskBanner
              kind="deleted"
              onprimary={() => void saveOrphanAsNew()}
              onsecondary={() => knowledge.closeDeleted()}
            />
            <TextArea
              id="deleted-item-text"
              label="Deleted item text"
              hideLabel
              readonly
              rows={12}
              value={itemDraft.text}
            />
          </div>
        {/if}
      </div>
    </Panel>
  </div>
</DropZone>
