<script lang="ts">
  import { tick } from 'svelte'
  import { attachmentUrl, type AttachmentScope } from '../../attachment-url'
  import type { AttachmentKind } from '@shared/attachments'
  import AttachmentChip from './AttachmentChip.svelte'
  import ImagePreview from './ImagePreview.svelte'

  export interface AttachmentRowItem {
    key: string
    name: string
    size?: number
    kind?: AttachmentKind
    /** Main's id: present once the file is staged (or sent). */
    id?: string
    state?: 'staging' | 'ready' | 'error'
  }

  interface Props {
    items: AttachmentRowItem[]
    /** Omit for a sent message: the row is then read-only. */
    onremove?: (key: string) => void
    scope?: AttachmentScope
    /** Where focus goes when the last chip is removed by keyboard. */
    focusFallback?: () => HTMLElement | null
  }

  let { items, onremove, scope = 'staged', focusFallback }: Props = $props()

  let toolbar: HTMLElement | undefined = $state()
  let activeKey = $state<string | null>(null)
  let previewing = $state<AttachmentRowItem | null>(null)

  const tabKey = $derived(items.some((item) => item.key === activeKey) ? activeKey : items[0]?.key)

  const canOpen = (item: AttachmentRowItem): boolean =>
    item.kind === 'image' && item.id !== undefined && (item.state ?? 'ready') === 'ready'

  function chipOf(key: string): HTMLElement | null {
    return (
      toolbar?.querySelector<HTMLElement>(
        `[data-attachment-item="${key}"] [data-attachment-chip]`
      ) ?? null
    )
  }

  function onfocusin(event: FocusEvent): void {
    const li = (event.target as HTMLElement).closest<HTMLElement>('[data-attachment-item]')
    if (li) activeKey = li.dataset.attachmentItem ?? null
  }

  function focusAt(index: number): void {
    const item = items[index]
    if (item) chipOf(item.key)?.focus()
  }

  async function removeAt(index: number): Promise<void> {
    const item = items[index]
    if (!item || !onremove) return
    const neighbour = items[index + 1] ?? items[index - 1]
    onremove(item.key)
    await tick()
    if (neighbour) focusAt(items.findIndex((entry) => entry.key === neighbour.key))
    else focusFallback?.()?.focus()
  }

  function onkeydown(event: KeyboardEvent): void {
    const li = (event.target as HTMLElement).closest<HTMLElement>('[data-attachment-item]')
    const index = items.findIndex((item) => item.key === li?.dataset.attachmentItem)
    if (index < 0) return
    const item = items[index]!
    const onChip = (event.target as HTMLElement).hasAttribute('data-attachment-chip')
    switch (event.key) {
      case 'ArrowRight':
        focusAt(Math.min(index + 1, items.length - 1))
        break
      case 'ArrowLeft':
        focusAt(Math.max(index - 1, 0))
        break
      case 'Home':
        focusAt(0)
        break
      case 'End':
        focusAt(items.length - 1)
        break
      case 'Enter':
      case ' ':
        // On the chip itself only: the buttons inside answer these keys natively.
        if (!onChip || !canOpen(item)) return
        previewing = item
        break
      case 'Delete':
      case 'Backspace':
        void removeAt(index)
        break
      default:
        return
    }
    event.preventDefault()
  }
</script>

{#snippet chips()}
  <ul
    data-attachment-row
    aria-label="Attached files"
    aria-busy={items.some((item) => item.state === 'staging') ? true : undefined}
    class="m-0 flex list-none flex-wrap gap-1.5 p-0"
  >
    {#each items as item (item.key)}
      <li data-attachment-item={item.key} class="flex max-w-full min-w-0">
        <AttachmentChip
          name={item.name}
          size={item.size}
          kind={item.kind}
          id={item.id}
          {scope}
          state={item.state}
          onremove={onremove ? () => onremove(item.key) : undefined}
          onopen={canOpen(item) ? () => (previewing = item) : undefined}
          tabindex={onremove ? (item.key === tabKey ? 0 : -1) : undefined}
        />
      </li>
    {/each}
  </ul>
{/snippet}

{#if items.length > 0}
  {#if onremove}
    <!-- svelte-ignore a11y_interactive_supports_focus (the chips inside are the roving tab stops) -->
    <div bind:this={toolbar} role="toolbar" aria-label="Attachments" {onkeydown} {onfocusin}>
      {@render chips()}
    </div>
  {:else}
    {@render chips()}
  {/if}
{/if}

{#if previewing && previewing.id !== undefined}
  <ImagePreview
    src={attachmentUrl(scope, previewing.id)}
    name={previewing.name}
    onclose={() => (previewing = null)}
  />
{/if}
