<script lang="ts">
  import Checkbox from '../ui/Checkbox.svelte'
  import type { ReviewFile, ReviewFileStatus, ReviewUncommittedFile } from '@shared/types/review'

  interface Props {
    /** A session file, or one of the user's uncommitted edits (no workers, no actions). */
    file: ReviewFile | ReviewUncommittedFile
    source?: 'session' | 'uncommitted'
    selected?: boolean
    /** The row that takes the tab stop when nothing is selected. */
    first?: boolean
    projectId?: string
    onselect?: () => void
    /** Ticks or unticks a session file. */
    onreview?: (reviewed: boolean) => void
  }

  let {
    file,
    source = 'session',
    selected = false,
    first = false,
    projectId = '',
    onselect,
    onreview
  }: Props = $props()

  const STATUS: Record<ReviewFileStatus, { label: string; tone: string }> = {
    A: { label: 'Added', tone: 'text-success' },
    M: { label: 'Changed', tone: 'text-accent' },
    D: { label: 'Deleted', tone: 'text-danger' },
    R: { label: 'Renamed', tone: 'text-attention-text' }
  }

  const status = $derived(STATUS[file.status])
  const workers = $derived('workers' in file ? file.workers : null)
  const workerText = $derived(workers?.join(', ') ?? '')
  const reviewable = $derived('reviewed' in file)
  const reviewed = $derived('reviewed' in file && file.reviewed)
  const changedSince = $derived('changedSinceReviewed' in file && file.changedSinceReviewed)
  const label = $derived(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)
</script>

<!-- The listbox owns arrow-key movement; the selected row (or the first) is the one tab stop. -->
<div
  role="option"
  tabindex={selected || first ? 0 : -1}
  onclick={() => onselect?.()}
  onkeydown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onselect?.()
    }
  }}
  aria-selected={selected}
  data-review-file={file.path}
  data-review-source={source}
  data-reviewed={reviewed ? 'true' : undefined}
  data-changed-since-reviewed={changedSince ? 'true' : undefined}
  class="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-control border px-2 py-1.5 text-left focus:outline-none focus-visible:shadow-focus {selected
    ? 'border-border-strong bg-accent/10'
    : 'border-transparent hover:bg-accent/5'}"
>
  {#if reviewable}
    <!-- Ticking must not select the row, and Space on the box must not reach the row's key handler. -->
    <span
      role="presentation"
      class="shrink-0"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
    >
      <Checkbox
        id="reviewed-row-{projectId}-{file.path}"
        label="Reviewed {file.path}"
        hideLabel
        checked={reviewed}
        onchange={() => onreview?.(!reviewed)}
      />
    </span>
  {/if}
  <div class="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
    <span class="min-w-0 truncate font-mono text-xs text-text" title={label}>
      {label}
    </span>
    <span class="shrink-0 font-mono text-xs" data-counts>
      {#if file.binary}
        <span class="text-text-muted">binary</span>
      {:else if file.large && file.added === 0 && file.removed === 0}
        <span class="text-text-muted">too large</span>
      {:else}
        <span class="text-success">+{file.added}</span>
        <span class="text-danger">−{file.removed}</span>
      {/if}
    </span>
    <span
      class="flex min-w-0 items-center gap-1.5 text-xs font-semibold tracking-label uppercase {status.tone}"
    >
      <span class="font-mono" aria-hidden="true">{file.status}</span>
      <span>{status.label}</span>
    </span>
    {#if changedSince}
      <span
        class="justify-self-end rounded-control border border-attention/60 bg-attention/10 px-1.5 text-xs font-semibold text-attention-text"
        data-changed-since>Changed since reviewed</span
      >
    {/if}
    {#if workers}
      <span
        class="col-span-2 mt-0.5 min-w-0 truncate font-mono text-xs text-text-muted"
        data-workers
        aria-label="Changed by {workerText}"
      >
        {#each workers as worker, i (worker)}<span
            class={worker === 'You' ? 'italic' : 'text-text'}
            data-worker-chip>{worker}</span
          >{i < workers.length - 1 ? ', ' : ''}{/each}
      </span>
    {/if}
  </div>
</div>
