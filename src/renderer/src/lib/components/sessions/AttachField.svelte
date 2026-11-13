<script lang="ts">
  import { onDestroy, type Snippet } from 'svelte'
  import type { ProviderId } from '@shared/types/provider'
  import type { AppError } from '@shared/errors'
  import { extractPasted, hasPasted } from '../../attach-input'
  import { messageFor } from '../../ipc/messages'
  import { attachments, type AttachKey } from '../../stores/attachments.svelte'
  import DropZone from '../ui/DropZone.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import AttachmentRow from '../ui/AttachmentRow.svelte'
  import AttachmentNotices from './AttachmentNotices.svelte'

  interface Props {
    attachKey: AttachKey
    /** The host is sending; nothing may be added meanwhile. */
    disabled?: boolean
    /** The brain that receives the files, for the can't-read warning. */
    provider?: ProviderId
    onerror?: (message: string) => void
    /** The host's message box (and anything positioned against the action row). */
    children: Snippet
    /** The host's own actions, after the paperclip. */
    actions: Snippet
  }

  let {
    attachKey,
    disabled = false,
    provider = 'claude',
    onerror,
    children,
    actions
  }: Props = $props()

  const items = $derived(
    attachments.list(attachKey).map((item) => ({
      key: item.localId,
      id: item.id,
      name: item.name,
      kind: item.kind,
      size: item.size,
      state: item.state
    }))
  )

  let root: HTMLElement | undefined = $state()

  // A refusal reports an action the user just took: leaving the message box ends it. The files stay.
  onDestroy(() => attachments.clearRefused(attachKey))

  async function add(run: Promise<AppError | null>): Promise<void> {
    const failure = await run
    if (failure) onerror?.(messageFor(failure))
  }

  function drop(paths: string[]): void {
    if (!disabled) void add(attachments.addPaths(attachKey, paths))
  }

  function unreadable(files: File[]): void {
    if (disabled) return
    void attachments.refuse(
      attachKey,
      files.map((file) => ({ name: file.name, reason: 'unreadable' as const }))
    )
  }

  // The paste of any message box inside the field (it bubbles up from the textarea).
  function onpaste(event: ClipboardEvent): void {
    // Read the clipboard now: it is not available after an await.
    const pasted = extractPasted(event.clipboardData)
    if (!hasPasted(pasted) || disabled) return
    event.preventDefault()
    void add(attachments.addPasted(attachKey, pasted))
  }

  async function pick(): Promise<void> {
    const failure = await attachments.pick(attachKey)
    if (failure) onerror?.(messageFor(failure))
  }
</script>

<DropZone ondrop={drop} onunreadable={unreadable} label="Drop to attach" class="-m-1.5">
  <div bind:this={root} {onpaste} class="flex min-w-0 flex-col gap-2" data-attach-field>
    <AttachmentRow
      {items}
      onremove={(key) => void attachments.remove(attachKey, key)}
      focusFallback={() => root?.querySelector('textarea') ?? null}
    />
    <AttachmentNotices
      refused={attachments.refused(attachKey)}
      {provider}
      kinds={items.map((item) => item.kind)}
      ondismiss={(indices) => attachments.dismissRefused(attachKey, indices)}
    />
    <div class="relative flex items-end gap-2">
      {@render children()}
      <IconButton label="Attach files" icon="paperclip" {disabled} onclick={() => void pick()} />
      {@render actions()}
    </div>
  </div>
</DropZone>
