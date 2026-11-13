<script lang="ts">
  import type { BranchChoiceValue } from '@shared/types/session'
  import Banner from '../Banner.svelte'
  import Button from '../Button.svelte'
  import ErrorText from '../ErrorText.svelte'
  import Radio from '../Radio.svelte'

  interface Props {
    /** The question id. */
    id: string
    from: string
    projectName: string
    /** The first changed paths (at most 10). */
    files: string[]
    /** How many changed paths are not in `files`. */
    moreFiles: number
    /** Labels of the workers waiting on this repository, such as "W3 web-fix". */
    workers: string[]
    /** Why "Bring them along" did not work; the other choices are offered again. */
    message?: string
    /** Sends the choice; resolves to an error message on failure. */
    onAnswer: (id: string, choice: BranchChoiceValue) => Promise<string | null | void> | void
  }

  let { id, from, projectName, files, moreFiles, workers, message, onAnswer }: Props = $props()

  const CHOICES: { value: BranchChoiceValue; label: string; hint: string }[] = [
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
      hint: 'Takes the changes onto the session branch.'
    },
    {
      value: 'skip',
      label: "Don't start",
      hint: 'The worker is not started and {project} is left as it is.'
    }
  ]

  // After a failed carry the card offers the other three choices again.
  const options = $derived(message ? CHOICES.filter((c) => c.value !== 'carry') : CHOICES)

  $effect(() => {
    if (message && choice === 'carry') choice = ''
  })

  // No default: the user chooses.
  let choice = $state('')
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function submit(): Promise<void> {
    if (busy || choice === '') return
    busy = true
    error = null
    try {
      const result = await onAnswer(id, choice as BranchChoiceValue)
      if (typeof result === 'string') error = result
    } catch {
      error = 'Could not send the answer. Try again.'
    } finally {
      busy = false
    }
  }
</script>

<article
  class="flex flex-col gap-3 rounded-hud border border-accent/45 bg-accent/10 p-4"
  data-kind="branch"
  data-branch-card={id}
  aria-label="Unsaved changes in {projectName}"
>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-semibold tracking-label text-accent uppercase">Unsaved changes</p>
    <h3 class="text-sm font-medium text-text">Unsaved changes in {projectName}</h3>
    <p class="text-sm text-text-muted">{from}</p>
  </div>
  {#if message}
    <Banner kind="warning"><span data-branch-message>{message}</span></Banner>
  {/if}
  {#if workers.length > 0}
    <p class="text-sm text-text" data-branch-workers>
      Waiting to start: {workers.join(', ')}
    </p>
  {/if}
  <ul class="flex flex-col font-mono text-xs text-text-muted" data-branch-files>
    {#each files as file (file)}<li class="truncate">{file}</li>{/each}
    {#if moreFiles > 0}<li>and {moreFiles} more</li>{/if}
  </ul>
  <div class="flex flex-col" role="radiogroup" aria-label="What to do with these changes">
    {#each options as option (option.value)}
      <div data-branch-choice={option.value}>
        <Radio
          id="branch-{id}-{option.value}"
          name="branch-{id}"
          label={option.label}
          description={option.hint.replace('{project}', projectName)}
          value={option.value}
          bind:group={choice}
          disabled={busy}
        />
      </div>
    {/each}
  </div>
  {#if error}<ErrorText message={error} />{/if}
  <div class="flex justify-end" data-branch-continue>
    <Button variant="primary" disabled={choice === '' || busy} {busy} onclick={() => void submit()}
      >Continue</Button
    >
  </div>
</article>
