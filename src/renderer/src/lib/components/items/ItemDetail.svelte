<script lang="ts">
  import { ITEM_DESCRIPTION_MAX } from '@shared/limits'
  import type { ItemSummary } from '@shared/types/item'
  import { messageFor } from '../../ipc/messages'
  import { itemDraft } from '../../stores/item-draft.svelte'
  import { knowledge, validateItemTitle } from '../../stores/knowledge.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import { ui } from '../../stores/ui.svelte'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import TextField from '../ui/TextField.svelte'
  import ChangedOnDiskBanner from '../banners/ChangedOnDiskBanner.svelte'
  import { revealInFinder } from '../../reveal'
  import SaveIndicator from '../ui/SaveIndicator.svelte'
  import MarkdownEditor from './MarkdownEditor.svelte'
  import TextDocEditor from './TextDocEditor.svelte'
  import { extensionOf } from '../../editor/languages'
  import MarkdownPreview from './MarkdownPreview.svelte'
  import ImageViewer from './ImageViewer.svelte'
  import PdfViewer from './PdfViewer.svelte'
  import type { BinaryItemContent } from '@shared/types/item'

  let { item }: { item: ItemSummary } = $props()

  // svelte-ignore state_referenced_locally
  let title = $state(item.title)
  // svelte-ignore state_referenced_locally
  let description = $state(item.description)
  let titleError = $state<string | null>(null)
  const isMarkdown = $derived(extensionOf(item.fileName) === 'md')
  let mode = $state<'edit' | 'preview'>('edit')

  let binary = $state<BinaryItemContent | null>(null)
  let readFailed = $state(false)
  let tooLarge = $state(false)

  $effect(() => {
    const id = item.id
    const rev = item.revision
    binary = null
    readFailed = false
    tooLarge = false
    if (item.editable) return
    void window.harness.invoke('items:read', { itemId: id }).then((res) => {
      if (item.id !== id || item.revision !== rev) return
      if (res.ok && res.data.type === 'binary') binary = res.data
      else if (!res.ok && res.error.code === 'FILE_TOO_LARGE') tooLarge = true
      else readFailed = true
    })
  })

  // Pick up server-side changes (e.g. a rename normalising the title).
  $effect(() => {
    title = item.title
    description = item.description
  })

  async function commitTitle(): Promise<void> {
    const error = validateItemTitle(title)
    if (error) {
      titleError = error
      return
    }
    titleError = null
    if (title.trim() === item.title) return
    await itemDraft.flush()
    const result = await knowledge.rename(item.id, title.trim())
    if ('code' in result) {
      titleError = messageFor(result)
      return
    }
    itemDraft.setRevision(item.id, result.revision)
  }

  async function commitDescription(): Promise<void> {
    const next = description.trim()
    if (next === item.description) return
    const failure = await knowledge.setDescription(item.id, next)
    if (failure) toasts.show(messageFor(failure), 'error')
  }

  async function saveAsNew(): Promise<void> {
    const failure = await knowledge.saveDeletedAsNew(item.sectionId, item.title)
    if (failure) toasts.show(messageFor(failure), 'error')
  }

  function blurOnEnter(event: KeyboardEvent): void {
    if (event.key === 'Enter') (event.currentTarget as HTMLElement).blur()
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-3">
  <div class="flex shrink-0 items-start justify-between gap-3">
    <div class="flex flex-1 flex-col gap-1">
      <TextField
        id="item-title"
        label="Title"
        hideLabel
        bind:value={title}
        error={titleError}
        onblur={commitTitle}
        onkeydown={blurOnEnter}
      />
      <TextField
        id="item-description"
        label="Description"
        hideLabel
        placeholder="Add a description"
        maxlength={ITEM_DESCRIPTION_MAX}
        bind:value={description}
        onblur={commitDescription}
        onkeydown={blurOnEnter}
      />
    </div>
    <div class="flex gap-2">
      <Button
        onclick={() =>
          ui.selectedGroupId &&
          void revealInFinder({
            groupId: ui.selectedGroupId,
            sectionId: item.sectionId,
            itemId: item.id
          })}
      >
        Show in Finder
      </Button>
      <Button
        variant="danger"
        onclick={() => ui.openDialog({ kind: 'item-delete', itemId: item.id })}
      >
        Delete
      </Button>
    </div>
  </div>

  {#if item.editable}
    <div class="flex shrink-0 items-center justify-between gap-4 pb-1">
      {#if isMarkdown}
        <div class="flex gap-1" role="group" aria-label="View mode">
          <Button
            variant={mode === 'edit' ? 'primary' : 'secondary'}
            onclick={() => (mode = 'edit')}>Edit</Button
          >
          <Button
            variant={mode === 'preview' ? 'primary' : 'secondary'}
            onclick={() => (mode = 'preview')}>Preview</Button
          >
        </div>
      {:else}
        <span></span>
      {/if}
      <SaveIndicator status={itemDraft.status} />
    </div>
    {#if itemDraft.external === 'changed'}
      <ChangedOnDiskBanner
        kind="changed"
        onprimary={() => void itemDraft.reload()}
        onsecondary={() => void itemDraft.keepMine()}
      />
    {:else if itemDraft.external === 'deleted'}
      <ChangedOnDiskBanner
        kind="deleted"
        onprimary={() => void saveAsNew()}
        onsecondary={() => knowledge.closeDeleted()}
      />
    {/if}
    {#if itemDraft.loading}
      <p class="text-sm text-text-muted">Loading…</p>
    {:else if !isMarkdown}
      <TextDocEditor
        value={itemDraft.text}
        fileName={item.fileName}
        onchange={(text) => itemDraft.edit(text)}
        onblur={() => void itemDraft.flush()}
      />
    {:else if mode === 'edit'}
      <MarkdownEditor
        value={itemDraft.text}
        onchange={(text) => itemDraft.edit(text)}
        onblur={() => void itemDraft.flush()}
      />
    {:else}
      <div class="min-h-0 flex-1 overflow-auto pt-3" data-preview-scroll>
        <MarkdownPreview source={itemDraft.text} />
      </div>
    {/if}
  {:else if binary && binary.mime === 'application/pdf'}
    <div class="flex min-h-0 flex-1 flex-col"><PdfViewer url={binary.url} /></div>
  {:else if binary && binary.mime.startsWith('image/')}
    <div class="flex min-h-0 flex-1 flex-col">
      <ImageViewer url={binary.url} alt={item.title} />
    </div>
  {:else if tooLarge}
    <EmptyState icon="file" text="This file is too large to open here. Use Show in Finder." />
  {:else if binary || readFailed}
    <EmptyState icon="file" text="This file can't be edited here." />
  {/if}
</div>
