<script lang="ts">
  import { messageFor } from '../../ipc/messages'
  import { review } from '../../stores/review.svelte'
  import Banner from '../ui/Banner.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Panel from '../ui/Panel.svelte'
  import DiffView from './DiffView.svelte'
  import ReviewFileList from './ReviewFileList.svelte'
  import ReviewHeader from './ReviewHeader.svelte'

  interface Props {
    onback: () => void
  }

  let { onback }: Props = $props()

  function inTextEntry(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false
    return target.matches('input, textarea, select') || target.isContentEditable
  }

  // j/k change file, n/p change hunk; typing in a field never triggers them.
  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
    if (inTextEntry(event.target)) return
    if (event.key === 'j') review.moveSelection('next')
    else if (event.key === 'k') review.moveSelection('prev')
    else if (event.key === 'n') review.stepHunk(1)
    else if (event.key === 'p') review.stepHunk(-1)
    else return
    event.preventDefault()
  }
</script>

<svelte:window {onkeydown} />

<div
  class="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-3"
  data-review-screen
>
  <Panel as="div">
    <ReviewHeader
      fileCount={review.fileCount}
      reviewedCount={review.reviewedCount}
      notice={review.notice}
      repos={review.repos}
      workers={review.workers}
      bind:repoFilter={review.repoFilter}
      bind:workerFilter={review.workerFilter}
      bind:layout={review.layout}
      draftCount={review.draftCount}
      goneNotes={review.goneNotes}
      onsend={() => review.sendNotes()}
      {onback}
    />
  </Panel>
  <div class="grid min-h-0 min-w-0 grid-cols-[minmax(260px,320px)_minmax(0,1fr)] gap-3">
    <Panel as="nav" scroll aria-label="Changed files" class="min-h-0">
      {#if review.loadError}
        <div class="p-3"><Banner kind="error">{messageFor(review.loadError)}</Banner></div>
      {:else if !review.loaded}
        <p class="p-3 text-sm text-text-muted" role="status">Loading changes</p>
      {:else if review.isFiltered && review.visibleRepos.length === 0}
        <div class="px-3"><EmptyState text="No files match these filters" /></div>
      {:else}
        <ReviewFileList
          repos={review.visibleRepos}
          selected={review.selected}
          onselect={(projectId, source, path) => review.select(projectId, source, path)}
        />
      {/if}
    </Panel>
    <Panel as="div" class="min-h-0">
      {#if review.selectedFile}
        <DiffView file={review.selectedFile} />
      {:else}
        <div class="px-3"><EmptyState text="Select a file to see its changes" /></div>
      {/if}
    </Panel>
  </div>
</div>
