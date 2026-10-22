<script lang="ts">
  import type { ReviewFileStatus, ReviewUncommittedFile } from '@shared/types/review'
  import { tick } from 'svelte'
  import { messageFor } from '../../ipc/messages'
  import { toSplitRows, toUnifiedRows } from '../../review/diff-rows'
  import { anchorKey, withSplitNotes, withUnifiedNotes } from '../../review/note-rows'
  import { review } from '../../stores/review.svelte'
  import Banner from '../ui/Banner.svelte'
  import Checkbox from '../ui/Checkbox.svelte'
  import Button from '../ui/Button.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import UndoDialog from './UndoDialog.svelte'
  import DiffSplit from './DiffSplit.svelte'
  import DiffUnified from './DiffUnified.svelte'
  import NoteThread from './NoteThread.svelte'

  interface Props {
    file: ReviewUncommittedFile
  }

  let { file }: Props = $props()

  const STATUS: Record<ReviewFileStatus, string> = {
    A: 'Added',
    M: 'Changed',
    D: 'Deleted',
    R: 'Renamed'
  }

  const diff = $derived(review.diff)
  const split = $derived(review.layout === 'split')
  const rows = $derived(diff?.kind === 'text' && !split ? toUnifiedRows(diff.hunks) : [])
  const splitRows = $derived(diff?.kind === 'text' && split ? toSplitRows(diff.hunks) : [])
  const label = $derived(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)
  const sessionFile = $derived(review.selectedSessionFile)
  const repo = $derived(review.selectedRepo)
  // Hand edits take no notes: a note is about the session's committed changes.
  const noteContext = $derived(
    review.selected?.source === 'session'
      ? { projectId: review.selected.projectId, path: review.selected.path }
      : null
  )
  /** Notes of this file whose line is not in the diff now (its hunk moved or the diff has no text). */
  const looseNotes = $derived.by(() => {
    if (!noteContext || diff === null) return []
    const own = review.notes.filter(
      (n) => n.projectId === noteContext.projectId && n.path === noteContext.path
    )
    if (own.length === 0) return own
    const wanted = new Set(own.map((n) => anchorKey(n.side, n.line)))
    const placed =
      diff.kind !== 'text'
        ? new Set<string>()
        : split
          ? withSplitNotes(splitRows, wanted).placed
          : withUnifiedNotes(rows, wanted).placed
    return own.filter((n) => !placed.has(anchorKey(n.side, n.line)))
  })
  let undoWorkers = $state<string[] | null>(null)

  async function startUndo(): Promise<void> {
    const sel = review.selected
    if (!sel) return
    const res = await review.undoPreview(sel.projectId, sel.path)
    if (Array.isArray(res)) undoWorkers = res
    else toasts.show(messageFor(res), 'error')
  }

  async function afterUndo(): Promise<void> {
    undoWorkers = null
    await tick()
    document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')?.focus()
  }

  const lines = (n: number): string => n.toLocaleString('en-US')
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-diff-view>
  <div class="flex shrink-0 items-center gap-3 border-b border-border px-3 py-2" data-diff-toolbar>
    <span class="min-w-0 truncate font-mono text-xs text-text" title={label}>{label}</span>
    <span class="shrink-0 text-xs font-semibold tracking-label text-text-muted uppercase"
      >{STATUS[file.status]}</span
    >
    {#if sessionFile}
      {#if sessionFile.changedSinceReviewed}
        <span
          class="shrink-0 rounded-control border border-attention/60 bg-attention/10 px-1.5 text-xs font-semibold text-attention-text"
          data-changed-since>Changed since reviewed</span
        >
      {/if}
      <div class="ml-auto flex shrink-0 items-center gap-3 text-sm text-text">
        <Button onclick={() => void startUndo()}>Undo changes</Button>
        <span class="flex items-center gap-1">
          <Checkbox
            id="reviewed-toolbar"
            label="Reviewed {sessionFile.path}"
            hideLabel
            checked={sessionFile.reviewed}
            onchange={() =>
              void review.setReviewed(
                review.selected?.projectId ?? '',
                sessionFile.path,
                !sessionFile.reviewed
              )}
          />
          <span aria-hidden="true">Reviewed</span>
        </span>
      </div>
    {/if}
  </div>
  {#if undoWorkers && repo && review.selected}
    <UndoDialog
      repoName={repo.projectName}
      branch={repo.branch}
      path={review.selected.path}
      activeWorkers={undoWorkers}
      onconfirm={() => review.undo(repo.projectId, review.selected?.path ?? '')}
      oncancel={() => (undoWorkers = null)}
      ondone={() => void afterUndo()}
    />
  {/if}
  {#if looseNotes.length > 0}
    <section class="shrink-0 border-b border-border p-3" data-loose-notes>
      <h3 class="m-0 mb-2 text-xs font-semibold tracking-label text-text-muted uppercase">
        Notes on lines not shown in this diff
      </h3>
      <NoteThread notes={looseNotes} showLine />
    </section>
  {/if}
  {#if review.diffError}
    <div class="p-3"><Banner kind="error">{messageFor(review.diffError)}</Banner></div>
  {:else if diff === null}
    <p class="p-3 text-sm text-text-muted" role="status">Loading changes</p>
  {:else if diff.kind === 'binary'}
    <p class="p-3 text-sm text-text-muted" data-diff-state="binary">Binary file changed</p>
  {:else if diff.kind === 'large'}
    <div class="flex flex-col items-start gap-3 p-3" data-diff-state="large">
      <p class="text-sm text-text">Large change: {lines(diff.changedLines)} lines</p>
      <Button onclick={() => review.showAnyway()}>Show anyway</Button>
    </div>
  {:else if diff.kind === 'tooLarge'}
    <p class="p-3 text-sm text-text-muted" data-diff-state="too-large">
      Too large to display{diff.changedLines > 0 ? ` (${lines(diff.changedLines)} lines)` : ''}
    </p>
  {:else if diff.hunks.length === 0}
    <p class="p-3 text-sm text-text-muted" data-diff-state="empty">No line changes</p>
  {:else}
    {#if split}
      <DiffSplit
        rows={splitRows}
        label="Changes in {label}"
        target={review.hunkTarget}
        {noteContext}
      />
    {:else}
      <DiffUnified {rows} label="Changes in {label}" target={review.hunkTarget} {noteContext} />
    {/if}
  {/if}
</div>
