<script lang="ts">
  // The fixed frame around one request that waits for the user. The body is drawn by SurfaceView;
  // this file is the only place a surface click can reach an answer call.
  import type { SurfaceAction } from '@shared/surface'
  import { toAnswer } from '@shared/attention-action'
  import type { AttentionView } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { activeSession } from '../../stores/active-session.svelte'
  import { toasts } from '../../stores/toasts.svelte'
  import SurfaceView from '../surface/SurfaceView.svelte'

  interface Props {
    request: AttentionView
  }

  let { request }: Props = $props()

  const KIND_LABEL: Record<AttentionView['kind'], string> = {
    permission: 'Permission',
    question: 'Question',
    branch: 'Unsaved changes'
  }
  const FRAME: Record<AttentionView['kind'], string> = {
    permission: 'border-attention/55 bg-attention/10',
    question: 'border-accent/45 bg-accent/10',
    branch: 'border-accent/45 bg-accent/10'
  }
  const LABEL: Record<AttentionView['kind'], string> = {
    permission: 'text-attention',
    question: 'text-accent',
    branch: 'text-accent'
  }

  const structured = $derived(request.kind === 'question' && (request.questions?.length ?? 0) > 0)
  const ariaLabel = $derived(
    request.kind === 'branch'
      ? `Unsaved changes in ${request.projectName}`
      : request.kind === 'question'
        ? `Question from ${request.from}`
        : `Permission request from ${request.from}`
  )

  const SEND_FAILED = 'Could not send the answer. Try again.'

  async function onAction(action: SurfaceAction): Promise<string | null> {
    const answer = toAnswer(request, action.name, action.context)
    if (answer === null) return SEND_FAILED
    if (answer.ipc === 'sessions:answer-branch-question') {
      // The panel and what was picked stay when this fails; the reason shows in the panel.
      return activeSession.answerBranchQuestion(answer.payload.questionId, answer.payload.choice)
    }
    const { requestId, ...body } = answer.payload
    const err = await activeSession.answerAttention(body, requestId)
    if (err) {
      toasts.show(messageFor(err), 'error')
      return messageFor(err)
    }
    return null
  }
</script>

<article
  class="flex flex-col gap-2 rounded-hud border p-3 outline-offset-2 data-highlight:outline-2 data-highlight:outline-accent {FRAME[
    request.kind
  ]}"
  data-request-panel={request.id}
  data-kind={request.kind}
  data-structured={structured ? '' : undefined}
  aria-label={ariaLabel}
>
  <div class="flex flex-col">
    <div class="flex flex-wrap items-baseline gap-x-2">
      <p class="text-xs font-semibold tracking-label uppercase {LABEL[request.kind]}">
        {KIND_LABEL[request.kind]}
      </p>
      <p class="text-sm text-text-muted">{request.from}</p>
    </div>
    {#if request.kind === 'branch'}
      <h3 class="text-sm font-medium text-text">Unsaved changes in {request.projectName}</h3>
    {/if}
  </div>
  <SurfaceView
    surface={request.surface}
    idPrefix="request-{request.id}"
    primaryVariant={request.kind === 'permission' ? 'attention' : 'primary'}
    {onAction}
  />
</article>
