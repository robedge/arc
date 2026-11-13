<script lang="ts">
  import { attachmentUrl, type AttachmentScope } from '../../attachment-url'
  import { formatBytes } from '../../format-bytes'
  import type { AttachmentKind } from '@shared/attachments'
  import Icon from './Icon.svelte'

  interface Props {
    name: string
    size?: number
    kind?: AttachmentKind
    /** Main's id; with a kind of image it gives the thumbnail. */
    id?: string
    scope?: AttachmentScope
    state?: 'staging' | 'ready' | 'error'
    /** Omit for a sent message: the chip is then read-only. */
    onremove?: () => void
    /** Opens the full-size image; given for ready images only. */
    onopen?: () => void
    /** The roving tab stop of a draft row; omit for a sent row. */
    tabindex?: number
  }

  let {
    name,
    size,
    kind,
    id,
    scope = 'staged',
    state: chipState = 'ready',
    onremove,
    onopen,
    tabindex
  }: Props = $props()

  let thumbFailed = $state(false)
  const thumb = $derived(kind === 'image' && id !== undefined && !thumbFailed)
</script>

{#snippet body()}
  {#if thumb && id !== undefined}
    <img
      data-attachment-thumb
      src={attachmentUrl(scope, id, true)}
      alt={name}
      class="size-12 shrink-0 rounded-control object-cover"
      onerror={() => (thumbFailed = true)}
    />
  {:else}
    <Icon name={kind === 'image' ? 'image' : 'file'} size={16} class="text-text-muted" />
  {/if}
  <span data-attachment-name title={name} class="max-w-48 min-w-0 truncate">{name}</span>
  {#if size !== undefined}
    <span data-attachment-size class="shrink-0 text-xs text-text-muted">{formatBytes(size)}</span>
  {:else if chipState === 'staging'}
    <span aria-hidden="true" class="shrink-0 text-xs text-text-muted motion-safe:animate-pulse"
      >Adding</span
    >
  {/if}
  {#if chipState === 'staging'}
    <span class="sr-only">Adding {name}</span>
  {:else if chipState === 'error'}
    <span class="sr-only">{name} could not be read</span>
  {/if}
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span
  data-attachment-chip
  data-attachment-state={chipState}
  role={tabindex === undefined ? undefined : 'group'}
  aria-label={tabindex === undefined
    ? undefined
    : chipState === 'staging'
      ? `Adding ${name}`
      : chipState === 'error'
        ? `${name} could not be read`
        : name}
  aria-busy={chipState === 'staging' ? true : undefined}
  {tabindex}
  class="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-control border {chipState ===
  'error'
    ? 'border-danger'
    : 'border-border-strong'} bg-surface-panel py-1 pr-1 pl-2 text-sm text-text focus:outline-none focus-visible:shadow-focus"
>
  {#if onopen}
    <button
      type="button"
      data-attachment-open
      aria-label="Preview {name}"
      tabindex={tabindex === undefined ? undefined : -1}
      onclick={onopen}
      class="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent p-0 text-sm text-text focus:outline-none focus-visible:shadow-focus"
    >
      {@render body()}
    </button>
  {:else}
    {@render body()}
  {/if}
  {#if onremove}
    <button
      type="button"
      data-attachment-remove
      tabindex="-1"
      aria-label="Remove {name}"
      title="Remove {name}"
      onclick={onremove}
      class="inline-flex size-hit shrink-0 cursor-pointer items-center justify-center rounded-control border-0 bg-transparent text-text-muted hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
    >
      <Icon name="close" size={16} />
    </button>
  {:else}
    <span class="pr-1"></span>
  {/if}
</span>
