<script lang="ts">
  import type { AttentionQuestion } from '@shared/types/session'
  import Button from '../Button.svelte'
  import Checkbox from '../Checkbox.svelte'
  import ErrorText from '../ErrorText.svelte'
  import TextField from '../TextField.svelte'

  interface Props {
    id: string
    from: string
    questions: AttentionQuestion[]
    /** Answers keyed by the exact question text; resolves to an error message, or nothing on success. */
    onSubmit: (
      id: string,
      answers: Record<string, string[]>
    ) => Promise<string | null | void> | void
    onDecline: (id: string) => Promise<string | null | void> | void
  }

  let { id, from, questions, onSubmit, onDecline }: Props = $props()

  // Chosen option labels and the typed "Other" text, per question index.
  let chosen = $state<string[][]>([])
  let other = $state<string[]>([])
  let error = $state<string | null>(null)
  let busy = $state(false)

  function chosenAt(i: number): string[] {
    return chosen[i] ?? []
  }

  function answerFor(i: number): string[] {
    const typed = (other[i] ?? '').trim()
    // Plain strings only: the answers cross the IPC bridge, which cannot clone a state proxy.
    return typed !== '' ? [typed] : [...chosenAt(i)]
  }

  const complete = $derived(questions.every((_, i) => answerFor(i).length > 0))

  function pick(i: number, label: string, multi: boolean): void {
    const current = chosenAt(i)
    if (multi) {
      chosen[i] = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
    } else {
      chosen[i] = [label]
    }
  }

  async function run(action: () => Promise<string | null | void> | void): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      const result = await action()
      if (typeof result === 'string') error = result
    } catch {
      error = 'Could not send the answer. Try again.'
    } finally {
      busy = false
    }
  }

  function submit(): void {
    if (!complete) return
    const answers: Record<string, string[]> = {}
    questions.forEach((q, i) => {
      answers[q.question] = answerFor(i)
    })
    void run(() => onSubmit(id, answers))
  }
</script>

<article
  class="flex flex-col gap-3 rounded-hud border border-accent/45 bg-accent/10 p-4"
  data-kind="question"
  data-structured
  aria-label="Question from {from}"
>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-semibold tracking-label text-accent uppercase">Question</p>
    <p class="text-sm text-text-muted">{from}</p>
  </div>

  {#each questions as q, i (i)}
    {@const typed = (other[i] ?? '').trim() !== ''}
    <section class="flex flex-col gap-2" data-question={i}>
      {#if q.header}
        <p class="text-xs font-semibold tracking-label text-text-muted uppercase">{q.header}</p>
      {/if}
      <p class="text-sm text-text">{q.question}</p>
      <div class="flex flex-col gap-2" role="group" aria-label={q.question}>
        {#each q.options as option, o (o)}
          {#if q.multiSelect}
            <div class="flex flex-col">
              <Checkbox
                id="opt-{id}-{i}-{o}"
                label={option.label}
                checked={chosenAt(i).includes(option.label)}
                onchange={() => pick(i, option.label, true)}
              />
              {#if option.description}
                <p class="pl-8 text-xs text-text-muted">{option.description}</p>
              {/if}
            </div>
          {:else}
            {@const selected = !typed && chosenAt(i).includes(option.label)}
            <button
              type="button"
              aria-pressed={selected}
              onclick={() => pick(i, option.label, false)}
              class="flex min-h-[var(--size-hit)] cursor-pointer flex-col items-start justify-center gap-0.5 rounded-hud border px-3 py-2 text-left focus:outline-none focus-visible:shadow-focus {selected
                ? 'border-accent bg-accent/20'
                : 'border-border-strong bg-surface-code'}"
            >
              <span class="text-sm text-text">{option.label}</span>
              {#if option.description}
                <span class="text-xs text-text-muted">{option.description}</span>
              {/if}
            </button>
          {/if}
        {/each}
      </div>
      <TextField
        id="other-{id}-{i}"
        label="Other"
        bind:value={() => other[i] ?? '', (v) => (other[i] = v)}
      />
    </section>
  {/each}

  {#if error}<ErrorText message={error} />{/if}
  <div class="flex justify-end gap-2">
    <Button variant="secondary" disabled={busy} onclick={() => void run(() => onDecline(id))}
      >Decline</Button
    >
    <Button variant="primary" disabled={!complete || busy} onclick={submit}>Submit</Button>
  </div>
</article>
