<script lang="ts">
  import type { DirtyChoiceValue, DirtyRepo, ResolveDirtyResult } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'
  import Radio from '../ui/Radio.svelte'

  interface Props {
    /** From the `needsDirtyChoice` result. */
    token: string
    repos: DirtyRepo[]
    /** Shown when the last try did not work (carrying the changes failed). */
    message?: string
    /** Called with the outcome of `sessions:resolve-dirty`, Cancel included (`cancelled`). */
    onresolved: (result: ResolveDirtyResult) => void
  }

  let { token, repos, message, onresolved }: Props = $props()

  const OPTIONS: { value: Exclude<DirtyChoiceValue, 'cancel'>; label: string; hint: string }[] = [
    {
      value: 'stash',
      label: 'Set aside',
      hint: 'Puts the changes in a git stash. Nothing is lost and you can bring them back later.'
    },
    {
      value: 'commit',
      label: 'Commit them first',
      hint: 'Saves them as a commit on the branch you are on now.'
    },
    {
      value: 'carry',
      label: 'Bring them along',
      hint: 'Takes the changes onto the new session branch.'
    }
  ]

  // No default: every repository needs an explicit choice.
  interface Entry {
    repo: DirtyRepo
    choice: string
  }
  // Writable derived: a new question (after a failed carry) starts with no choices.
  let entries = $derived<Entry[]>(repos.map((repo) => ({ repo, choice: '' })))
  let attempted = $state(false)
  let busy = $state(false)
  let serverError = $state<string | null>(null)

  async function resolve(choices: Record<string, DirtyChoiceValue>): Promise<void> {
    if (busy) return
    busy = true
    serverError = null
    try {
      const res = await window.harness.invoke('sessions:resolve-dirty', { token, choices })
      if (res.ok) onresolved(res.data)
      else serverError = messageFor(res.error)
    } finally {
      busy = false
    }
  }

  function onsubmit(): void {
    attempted = true
    if (entries.some((e) => e.choice === '')) return
    const choices: Record<string, DirtyChoiceValue> = {}
    for (const e of entries) choices[e.repo.projectId] = e.choice as DirtyChoiceValue
    void resolve(choices)
  }

  /** Cancel starts nothing: every repository is answered with 'cancel'. */
  function oncancel(): void {
    const choices: Record<string, DirtyChoiceValue> = {}
    for (const r of repos) choices[r.projectId] = 'cancel'
    void resolve(choices)
  }

  function moreFiles(repo: DirtyRepo): number {
    return Math.max(0, repo.fileCount - repo.files.length)
  }
</script>

<Modal title="Unsaved changes" size="lg" {onsubmit} {oncancel} {busy}>
  <p class="text-sm text-text">
    These repositories have changes that are not committed. Arc is about to move them to a new
    session branch. Choose what to do with the changes in each one.
  </p>
  {#if message}<Banner kind="warning">{message}</Banner>{/if}
  {#each entries as entry (entry.repo.projectId)}
    {@const repo = entry.repo}
    <fieldset class="flex flex-col" data-dirty-repo={repo.projectId}>
      <legend class="text-sm font-medium text-text">{repo.name}</legend>
      <ul class="my-1 flex flex-col font-mono text-xs text-text-muted">
        {#each repo.files as file (file)}<li class="truncate">{file}</li>{/each}
        {#if moreFiles(repo) > 0}<li>and {moreFiles(repo)} more</li>{/if}
      </ul>
      {#each OPTIONS as option (option.value)}
        <Radio
          id="dirty-{repo.projectId}-{option.value}"
          name="dirty-{repo.projectId}"
          label={option.label}
          description={option.hint}
          value={option.value}
          bind:group={entry.choice}
        />
      {/each}
      {#if attempted && entry.choice === ''}
        <ErrorText message="Choose what to do with these changes." />
      {/if}
    </fieldset>
  {/each}
  {#if serverError}<ErrorText message={serverError} />{/if}
  <div class="flex justify-end gap-2">
    <Button onclick={oncancel} disabled={busy}>Cancel</Button>
    <Button type="submit" variant="primary" {busy}>Continue</Button>
  </div>
</Modal>
