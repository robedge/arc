<script lang="ts">
  import type { AppError } from '@shared/errors'
  import type { ReviewNote } from '@shared/types/review'
  import { messageFor } from '../../ipc/messages'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Icon from '../ui/Icon.svelte'
  import Radio from '../ui/Radio.svelte'
  import Select from '../ui/Select.svelte'
  import { ALL, type ReviewLayout } from '../../stores/review.svelte'

  interface Props {
    fileCount: number
    /** Session files ticked as reviewed, over all repositories. */
    reviewedCount?: number
    /** "Updated: N more files changed"; announced politely. */
    notice?: string | null
    /** Repositories offered by the repository filter. */
    repos?: readonly { projectId: string; projectName: string }[]
    /** Worker labels offered by the worker filter. */
    workers?: readonly string[]
    repoFilter?: string
    workerFilter?: string
    layout?: ReviewLayout
    /** Notes not yet sent. */
    draftCount?: number
    /** Notes on files the session no longer changes. */
    goneNotes?: readonly ReviewNote[]
    /** Sends the drafts to the brain; returns the error to show, or null. */
    onsend?: () => Promise<AppError | null>
    onback: () => void
  }

  let {
    fileCount,
    reviewedCount = 0,
    notice = null,
    repos = [],
    workers = [],
    repoFilter = $bindable(ALL),
    workerFilter = $bindable(ALL),
    layout = $bindable('unified'),
    draftCount = 0,
    goneNotes = [],
    onsend,
    onback
  }: Props = $props()

  let sending = $state(false)
  let sendError = $state<string | null>(null)
  let goneOpen = $state(false)

  async function send(): Promise<void> {
    if (!onsend || sending) return
    sending = true
    sendError = null
    const error = await onsend()
    sending = false
    if (error) sendError = messageFor(error)
  }

  const projectName = (projectId: string): string =>
    repos.find((r) => r.projectId === projectId)?.projectName ?? projectId

  const repoOptions = $derived([
    { value: ALL, label: 'All repositories' },
    ...repos.map((r) => ({ value: r.projectId, label: r.projectName }))
  ])
  const workerOptions = $derived([
    { value: ALL, label: 'All workers' },
    ...workers.map((w) => ({ value: w, label: w }))
  ])
</script>

<div
  class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3 py-2"
  data-review-header
>
  <Button onclick={onback}
    ><Icon name="chevron" size={16} class="rotate-180" />Back to session</Button
  >
  <h2 class="shrink-0 font-display text-sm tracking-title text-text-muted uppercase">
    Review changes · {fileCount}
  </h2>
  {#if fileCount > 0}
    <div class="flex shrink-0 items-center gap-2" data-review-progress-wrap>
      <p class="text-xs whitespace-nowrap text-text" aria-live="polite" data-review-progress>
        {reviewedCount} of {fileCount} reviewed
      </p>
      <div
        class="h-1 w-16 overflow-hidden rounded-full bg-surface-code"
        aria-hidden="true"
        data-review-progress-bar
      >
        <div
          class="h-full bg-accent transition-[width] duration-(--duration-fast)"
          style:width="{Math.round((reviewedCount / fileCount) * 100)}%"
        ></div>
      </div>
    </div>
  {/if}
  <div class="flex shrink-0 items-end gap-2">
    <Select
      id="review-repo-filter"
      label="Repository"
      bind:value={repoFilter}
      options={repoOptions}
    />
    <Select
      id="review-worker-filter"
      label="Worker filter"
      bind:value={workerFilter}
      options={workerOptions}
    />
  </div>
  <fieldset
    class="m-0 flex shrink-0 items-center gap-3 border-0 p-0 whitespace-nowrap"
    data-review-layout
  >
    <legend class="sr-only">Diff layout</legend>
    <Radio
      id="review-layout-unified"
      name="review-layout"
      label="Single"
      value="unified"
      bind:group={layout}
    />
    <Radio
      id="review-layout-split"
      name="review-layout"
      label="Side-by-side"
      value="split"
      bind:group={layout}
    />
  </fieldset>
  <p
    class="ml-auto min-w-0 truncate text-xs text-text"
    role="status"
    aria-live="polite"
    data-review-notice
  >
    {notice ?? ''}
  </p>
  <Button variant="primary" disabled={draftCount === 0} busy={sending} onclick={() => void send()}
    >Send {draftCount} {draftCount === 1 ? 'note' : 'notes'} to brain</Button
  >
  {#if sendError}
    <div class="basis-full"><ErrorText message={sendError} /></div>
  {/if}
  {#if goneNotes.length > 0}
    <div class="basis-full text-xs text-text" data-gone-notes>
      <button
        type="button"
        class="cursor-pointer rounded-control border-0 bg-transparent p-0 text-xs text-text underline focus-visible:shadow-focus focus-visible:outline-none"
        aria-expanded={goneOpen}
        aria-controls="review-gone-notes"
        onclick={() => (goneOpen = !goneOpen)}
        >{goneNotes.length}
        {goneNotes.length === 1 ? 'note' : 'notes'} on files no longer changed</button
      >
      {#if goneOpen}
        <ul id="review-gone-notes" class="m-0 mt-2 flex list-none flex-col gap-2 p-0">
          {#each goneNotes as note (note.id)}
            <li class="rounded-control border border-border-strong p-2" data-gone-note>
              <p class="m-0 font-mono text-text-muted">
                {projectName(note.projectId)} · {note.path} · line {note.line} ({note.side})
                {#if note.state === 'sent'}<span class="font-semibold">· Sent</span>{/if}
              </p>
              <p class="m-0 mt-1 text-sm break-words whitespace-pre-wrap">{note.body}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
