<script lang="ts">
  import type { WorkerView } from '@shared/types/session'
  import { activeSession } from '../../stores/active-session.svelte'
  import { usage } from '../../stores/usage.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Panel from '../ui/Panel.svelte'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import LiveMark from '../ui/LiveMark.svelte'
  import TokenCount from '../ui/TokenCount.svelte'
  import {
    WORKER_STATUS,
    WORKER_TONE_CLASS,
    controlLabel,
    helpersLabel,
    workerTitle
  } from './worker-status'

  interface Props {
    worker: WorkerView
    onopen: (workerId: string) => void
    ondetails?: (workerId: string) => void
  }

  let { worker, onopen, ondetails }: Props = $props()

  /** The provider reports no tokens for this worker (Cursor): its null reads "Not reported". */
  const notReported = $derived(
    usage.bySession[worker.sessionId]?.agents.find((a) => a.agentKey === worker.id)?.recording ===
      'not-reported'
  )

  /** The command's arguments, shown in the title tooltip next to the label. */
  function argsOf(command: string): string {
    return command.replace(/^\/\S+\s*/, '')
  }

  const status = $derived(WORKER_STATUS[worker.status])
  // While the user is in control the real status still applies underneath, but the card neither
  // turns amber nor opens Needs attention: the user answers in the worker's terminal.
  const control = $derived(controlLabel(worker))
  const attention = $derived(!control && status.tone === 'attention')
  const helpers = $derived(helpersLabel(worker.helpersRunning))

  // In an attention state the card opens the dialog with its own request first.
  function open(): void {
    const request = attention
      ? activeSession.queueAttention.find((r) => r.workerId === worker.id)
      : null
    if (request) activeSession.openAttention(request.id)
    else onopen(worker.id)
  }
</script>

<Panel
  as="div"
  tone={attention ? 'attention' : 'default'}
  data-worker-card={worker.status}
  data-worker-id={worker.id}
>
  <div class="flex items-center gap-1 pr-2">
    <button
      type="button"
      onclick={open}
      class="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2 text-left focus:outline-none focus-visible:shadow-focus"
    >
      <span class="flex items-center justify-between gap-2">
        <span
          class="min-w-0 truncate text-sm font-medium text-text {worker.command ? 'font-mono' : ''}"
          data-worker-title
          title={worker.command
            ? `${workerTitle(worker)} ${argsOf(worker.command)}`.trim()
            : undefined}>{workerTitle(worker)}</span
        >
        <span
          class="shrink-0 text-xs font-semibold tracking-label uppercase {control
            ? WORKER_TONE_CLASS.accent
            : WORKER_TONE_CLASS[status.tone]}"
          data-worker-status
          data-worker-control={control ? worker.userControl : undefined}
          >{control ?? status.label}</span
        >
      </span>
      <span class="flex items-center justify-between gap-2">
        <ProviderTag runningOn={worker.runningOn} model={worker.model} data-worker-model />
        {#if worker.tokens !== undefined}
          <span class="flex shrink-0 items-center gap-1.5">
            {#if worker.tokensInFlight}<LiveMark />{/if}
            <TokenCount
              value={worker.tokens === null ? null : worker.tokens.total}
              {notReported}
              suffix="tokens"
              class="font-mono text-xs text-text-muted"
            />
          </span>
        {/if}
      </span>
      {#if worker.status === 'failed' && worker.failureReason}
        <ErrorText message={worker.failureReason} />
      {:else if worker.activity}
        <span class="truncate text-xs text-text-muted" title={worker.activity}
          >{worker.activity}</span
        >
      {/if}
      {#if helpers}
        <span
          class="w-fit rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted"
          data-worker-helpers={worker.helpersRunning}>{helpers}</span
        >
      {/if}
    </button>
    {#if ondetails}
      <span data-worker-details-button
        ><IconButton
          label="Details for {workerTitle(worker)}"
          icon="info"
          onclick={(event) => {
            event.stopPropagation()
            ondetails(worker.id)
          }}
        /></span
      >
    {/if}
  </div>
</Panel>
