<script lang="ts">
  import { unreadableKinds, type AttachmentKind, type AttachmentRefusal } from '@shared/attachments'
  import { providerName } from '@shared/provider-label'
  import type { ProviderId } from '@shared/types/provider'
  import { refusalMessage } from '../../attachments/refusal-message'
  import Icon from '../ui/Icon.svelte'

  interface Props {
    refused: AttachmentRefusal[]
    /** Removes the refusals at these positions of `refused`. */
    ondismiss: (indices: number[]) => void
    /** The brain that will receive the files, and the kinds of the files listed in the draft. */
    provider?: ProviderId
    kinds?: (AttachmentKind | undefined)[]
  }

  let { refused, ondismiss, provider = 'claude', kinds = [] }: Props = $props()

  const PLURAL: Record<AttachmentKind, string> = {
    image: 'images',
    pdf: 'PDFs',
    text: 'text files'
  }

  // Derived from the draft, never stored: it follows the files and the brain.
  const cantRead = $derived(
    unreadableKinds(provider, kinds).map((kind) => ({
      kind,
      text: `${providerName(provider)} can't read ${PLURAL[kind]}. It will be sent as a file the brain may not be able to open.`
    }))
  )

  const MAX_LINES = 3

  interface Line {
    text: string
    label: string
    indices: number[]
  }

  // One line per refused file; every "too many" refusal says the same thing, so they share a line.
  const all = $derived.by(() => {
    const result: Line[] = []
    let tooMany: Line | undefined
    refused.forEach((refusal, index) => {
      if (refusal.reason === 'too_many' && tooMany) {
        tooMany.indices.push(index)
        return
      }
      const text = refusalMessage(refusal)
      const line: Line = {
        text,
        label: refusal.name,
        indices: [index]
      }
      if (refusal.reason === 'too_many') tooMany = line
      result.push(line)
    })
    return result
  })
  const shown = $derived(all.slice(0, MAX_LINES))
  const hidden = $derived(all.length - shown.length)
</script>

<!-- The region stays in the page so a screen reader announces lines as they are added. -->
<div
  role="status"
  aria-label="Attachment notices"
  aria-live="polite"
  data-attachment-notices
  class="flex min-w-0 flex-col gap-1"
>
  {#each shown as line (line.indices[0])}
    <p data-notice-line class="flex items-start gap-1.5 text-sm text-text">
      <Icon name="error" size={16} class="mt-0.5 shrink-0 text-attention" />
      <span data-notice-text class="min-w-0 flex-1 break-words">{line.text}</span>
      <button
        type="button"
        aria-label="Dismiss: {line.label}"
        onclick={() => ondismiss(line.indices)}
        class="inline-flex size-hit shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-muted hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
      >
        <Icon name="close" size={16} />
      </button>
    </p>
  {/each}
  {#if hidden > 0}
    <p data-notice-more class="text-sm text-text-muted">and {hidden} more were refused.</p>
  {/if}
  {#each cantRead as warning (warning.kind)}
    <p data-notice-warning={warning.kind} class="flex items-start gap-1.5 text-sm text-text">
      <Icon name="warning" size={16} class="mt-0.5 shrink-0 text-attention" />
      <span data-notice-warning-text class="min-w-0 flex-1 break-words">{warning.text}</span>
    </p>
  {/each}
</div>
