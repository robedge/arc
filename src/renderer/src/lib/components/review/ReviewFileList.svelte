<script lang="ts">
  import { tick } from 'svelte'
  import type { AppError } from '@shared/errors'
  import type { ReviewPushPreview, ReviewRepo } from '@shared/types/review'
  import { messageFor } from '../../ipc/messages'
  import { review, type ReviewSelection } from '../../stores/review.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import Button from '../ui/Button.svelte'
  import PushDialog from './PushDialog.svelte'
  import ReviewFileRow from './ReviewFileRow.svelte'

  interface Props {
    repos: readonly ReviewRepo[]
    selected: ReviewSelection | null
    onselect: (projectId: string, source: ReviewSelection['source'], path: string) => void
  }

  let { repos, selected, onselect }: Props = $props()

  let root: HTMLDivElement | undefined = $state()

  /** The repository whose Push branch dialog is open, with the command the main process previewed. */
  let pushing = $state<{ repo: ReviewRepo; preview: ReviewPushPreview } | null>(null)

  async function startPush(repo: ReviewRepo): Promise<void> {
    const res = await review.pushPreview(repo.projectId)
    if ('code' in res) toasts.show(messageFor(res), 'error')
    else pushing = { repo, preview: res }
  }

  async function confirmPush(): Promise<AppError | null> {
    const target = pushing
    if (!target) return null
    const res = await review.push(target.repo.projectId)
    if ('code' in res) return res
    toasts.show(`Pushed ${target.repo.branch} to ${res.remote}`, 'success')
    return null
  }

  const pad = (n: number): string => String(n).padStart(2, '0')

  /** "14:02" in local time; with the date ("Oct 17, 14:02") when it was not today. */
  function pushedTime(at: number): string {
    const d = new Date(at)
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
    if (d.toDateString() === new Date().toDateString()) return time
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`
  }

  const newerCommits = (n: number): string => `${n} newer ${n === 1 ? 'commit' : 'commits'}`

  const isSelected = (
    projectId: string,
    source: ReviewSelection['source'],
    path: string
  ): boolean =>
    selected?.projectId === projectId && selected.source === source && selected.path === path

  /** The row that takes the tab stop when nothing is selected: the first row of the whole list. */
  const firstRow = $derived.by((): ReviewSelection | null => {
    for (const r of repos) {
      const session = r.files[0]
      if (session) return { projectId: r.projectId, source: 'session', path: session.path }
      const hand = r.uncommitted.state === 'ok' ? r.uncommitted.files[0] : undefined
      if (hand) return { projectId: r.projectId, source: 'uncommitted', path: hand.path }
    }
    return null
  })

  const MOVES: Record<string, 'next' | 'prev' | 'first' | 'last'> = {
    ArrowDown: 'next',
    ArrowUp: 'prev',
    Home: 'first',
    End: 'last'
  }

  async function onkeydown(event: KeyboardEvent): Promise<void> {
    const move = MOVES[event.key]
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    review.moveSelection(move)
    await tick()
    root?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
  }

  // Keep the selected row in view when `j`/`k` move it.
  $effect(() => {
    void selected
    root
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: 'nearest' })
  })
</script>

<div class="flex min-w-0 flex-col gap-4 p-3" data-review-file-list bind:this={root}>
  {#each repos as repo (repo.projectId)}
    <section aria-label={repo.projectName} class="flex min-w-0 flex-col gap-1">
      <h3 class="flex min-w-0 items-baseline gap-2">
        <span class="min-w-0 truncate text-sm font-semibold text-text-bright"
          >{repo.projectName}</span
        >
        <span class="min-w-0 truncate font-mono text-xs text-text-muted">{repo.branch}</span>
      </h3>
      <div class="flex min-w-0 flex-wrap items-center gap-2" data-review-push={repo.projectId}>
        {#if repo.push.state === 'no-remote' || repo.push.state === 'waiting'}
          <Button ariaDisabled ariaDescribedby="push-why-{repo.projectId}">Push branch</Button>
          <span id="push-why-{repo.projectId}" class="text-xs text-text-muted" data-push-why
            >{repo.push.state === 'no-remote'
              ? 'No remote configured'
              : 'Waiting for your checkout'}</span
          >
        {:else}
          <Button onclick={() => void startPush(repo)}>Push branch</Button>
          {#if repo.push.state === 'pushed'}
            <span class="text-xs text-success" data-push-tag
              >Pushed {pushedTime(repo.push.at)}{repo.push.newerCommits > 0
                ? ` · ${newerCommits(repo.push.newerCommits)}`
                : ''}</span
            >
          {/if}
        {/if}
      </div>
      {#if repo.files.length > 0}
        <div
          role="listbox"
          tabindex="-1"
          aria-label="Changed files in {repo.projectName}"
          class="flex min-w-0 flex-col gap-1 focus:outline-none"
          {onkeydown}
        >
          {#each repo.files as file (file.path)}
            <ReviewFileRow
              {file}
              projectId={repo.projectId}
              onreview={(reviewed) => void review.setReviewed(repo.projectId, file.path, reviewed)}
              selected={isSelected(repo.projectId, 'session', file.path)}
              first={selected === null &&
                firstRow?.projectId === repo.projectId &&
                firstRow.source === 'session' &&
                firstRow.path === file.path}
              onselect={() => onselect(repo.projectId, 'session', file.path)}
            />
          {/each}
        </div>
      {:else if repo.uncommitted.state !== 'ok' || repo.uncommitted.files.length === 0}
        <p class="text-xs text-text-muted">No changes in this repository.</p>
      {/if}
      {#if repo.uncommitted.state === 'ok' && repo.uncommitted.files.length > 0}
        <div class="mt-2 flex min-w-0 flex-col gap-1" data-review-uncommitted>
          <h4 class="text-xs font-semibold tracking-label text-text-muted uppercase">
            Not committed
          </h4>
          <div
            role="listbox"
            tabindex="-1"
            aria-label="Not committed files in {repo.projectName}"
            class="flex min-w-0 flex-col gap-1 focus:outline-none"
            {onkeydown}
          >
            {#each repo.uncommitted.files as file (file.path)}
              <ReviewFileRow
                {file}
                source="uncommitted"
                selected={isSelected(repo.projectId, 'uncommitted', file.path)}
                first={selected === null &&
                  firstRow?.projectId === repo.projectId &&
                  firstRow.source === 'uncommitted' &&
                  firstRow.path === file.path}
                onselect={() => onselect(repo.projectId, 'uncommitted', file.path)}
              />
            {/each}
          </div>
        </div>
      {:else if repo.uncommitted.state === 'other-branch'}
        <p class="mt-2 text-xs text-text-muted" data-review-uncommitted-note>
          {repo.uncommitted.current === null
            ? "Your checkout isn't on a branch, so uncommitted edits aren't shown."
            : `Your checkout is on ${repo.uncommitted.current}, so uncommitted edits aren't shown.`}
        </p>
      {:else if repo.uncommitted.state === 'unavailable'}
        <p class="mt-2 text-xs text-text-muted" data-review-uncommitted-note>
          Couldn't read your uncommitted edits.
        </p>
      {/if}
    </section>
  {/each}
</div>

{#if pushing}
  <PushDialog
    repoName={pushing.repo.projectName}
    command={pushing.preview.command}
    remote={pushing.preview.remote}
    onconfirm={confirmPush}
    oncancel={() => (pushing = null)}
    ondone={() => (pushing = null)}
  />
{/if}
