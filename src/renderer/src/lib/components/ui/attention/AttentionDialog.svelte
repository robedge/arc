<script lang="ts">
  import Modal from '../Modal.svelte'
  import Button from '../Button.svelte'
  import PermissionCard from './PermissionCard.svelte'
  import QuestionCard from './QuestionCard.svelte'
  import StructuredQuestionCard from './StructuredQuestionCard.svelte'
  import type { AttentionRequest } from './types'

  interface Props {
    open: boolean
    requests: AttentionRequest[]
    /** Shown first when it is in the list; otherwise the default order. */
    initialRequestId?: string | null
    onApprove: (id: string) => void
    onDeny: (id: string) => void
    onAlwaysAllow: (id: string) => void
    onAnswer: (id: string, text: string) => void
    /** Answers to a structured question, keyed by question text; resolves to an error message on failure. */
    onAnswerStructured?: (
      id: string,
      answers: Record<string, string[]>
    ) => Promise<string | null | void> | void
    /** Dismisses a structured question; resolves to an error message on failure. */
    onDecline?: (id: string) => Promise<string | null | void> | void
    onClose: () => void
  }

  let {
    open,
    requests,
    initialRequestId = null,
    onApprove,
    onDeny,
    onAlwaysAllow,
    onAnswer,
    onAnswerStructured = () => {},
    onDecline = () => {},
    onClose
  }: Props = $props()

  const ordered = $derived.by(() => {
    const first = requests.find((r) => r.id === initialRequestId)
    return first ? [first, ...requests.filter((r) => r !== first)] : requests
  })

  // Nothing left to decide: close instead of showing an empty dialog.
  $effect(() => {
    if (open && requests.length === 0) onClose()
  })
</script>

{#if open}
  <Modal
    title="Needs attention · {requests.length}"
    size="lg"
    onsubmit={() => {}}
    oncancel={onClose}
  >
    <div
      class="flex max-h-[min(60vh,32rem)] flex-col gap-3 overflow-y-auto pr-1"
      data-attention-list
    >
      {#each ordered as request (request.id)}
        {#if request.kind === 'permission'}
          <PermissionCard
            id={request.id}
            from={request.from}
            action={request.action}
            reason={request.reason}
            tool={request.tool}
            {onApprove}
            {onDeny}
            {onAlwaysAllow}
          />
        {:else if request.questions && request.questions.length > 0}
          <StructuredQuestionCard
            id={request.id}
            from={request.from}
            questions={request.questions}
            onSubmit={onAnswerStructured}
            {onDecline}
          />
        {:else}
          <QuestionCard
            id={request.id}
            from={request.from}
            question={request.question}
            onSend={onAnswer}
          />
        {/if}
      {/each}
    </div>
    <div class="flex justify-end">
      <Button variant="secondary" onclick={onClose}>Close</Button>
    </div>
  </Modal>
{/if}
