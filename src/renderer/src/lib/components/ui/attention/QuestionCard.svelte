<script lang="ts">
  import Button from '../Button.svelte'
  import TextField from '../TextField.svelte'

  interface Props {
    id: string
    from: string
    question: string
    onSend: (id: string, text: string) => void
  }

  let { id, from, question, onSend }: Props = $props()

  let answer = $state('')
  const empty = $derived(answer.trim() === '')

  function send(): void {
    if (empty) return
    onSend(id, answer.trim())
    answer = ''
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    send()
  }
</script>

<article
  class="flex flex-col gap-3 rounded-hud border border-accent/45 bg-accent/10 p-4"
  data-kind="question"
  aria-label="Question from {from}"
>
  <div class="flex flex-col gap-1">
    <p class="text-xs font-semibold tracking-label text-accent uppercase">Question</p>
    <p class="text-sm text-text-muted">{from}</p>
  </div>
  <p class="text-sm text-text">{question}</p>
  <div class="flex items-end gap-2">
    <div class="min-w-0 flex-1">
      <TextField id="answer-{id}" label="Your answer" bind:value={answer} {onkeydown} />
    </div>
    <Button variant="primary" disabled={empty} onclick={send}>Send</Button>
  </div>
</article>
