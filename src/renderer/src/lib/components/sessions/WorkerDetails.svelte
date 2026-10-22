<script lang="ts">
  import type { WorkerDetails, WorkerView } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Modal from '../ui/Modal.svelte'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import TokenCount from '../ui/TokenCount.svelte'
  import LiveMark from '../ui/LiveMark.svelte'
  import SetupSplit from './SetupSplit.svelte'
  import { usage } from '../../stores/usage.svelte'
  import { workerControl } from '../../stores/worker-control.svelte'
  import { workerTerminals } from '../../stores/worker-terminals.svelte'
  import {
    REMOVABLE,
    STOPPABLE,
    canStepIn,
    WORKER_STATUS,
    WORKER_TONE_CLASS,
    helpersLabel,
    unmergedWarning,
    workerTitle
  } from './worker-status'
  import { canContinue, continueWorker, freshUnmerged, removeWorker } from './worker-actions'

  interface Props {
    worker: WorkerView
    onclose: () => void
    /** Supplied by the Design Preview, which never talks to the main process. */
    preset?: WorkerDetails
  }

  let { worker, onclose, preset }: Props = $props()

  // svelte-ignore state_referenced_locally
  let details = $state<WorkerDetails | null>(preset ?? null)
  let confirming = $state(false)
  let removing = $state<'confirm' | 'busy' | null>(null)
  /** Unmerged commits read fresh when a confirmation opens. */
  let unmerged = $state(0)
  let stopping = $state(false)
  let continuing = $state(false)
  let error = $state<string | null>(null)

  const name = $derived(workerTitle(worker))
  const status = $derived(WORKER_STATUS[worker.status])
  const helpers = $derived(helpersLabel(worker.helpersRunning))
  const TOKEN_ROWS = [
    ['Input', 'input'],
    ['Cache write (cold)', 'cacheWrite'],
    ['Cache read (hit)', 'cacheRead'],
    ['Output', 'output'],
    ['Total', 'total']
  ] as const
  /** The agent's entry in the session snapshot when there is one, else the card's totals. */
  const agentUsage = $derived(
    usage.bySession[worker.sessionId]?.agents.find((a) => a.agentKey === worker.id)
  )
  const tokens = $derived(agentUsage ? agentUsage.tokens : (worker.tokens ?? null))

  $effect(() => {
    if (preset) return
    void worker.updatedAt
    const workerId = worker.id
    void window.harness.invoke('workers:get', { workerId }).then((res) => {
      if (res.ok && workerId === worker.id) details = res.data
      else if (!res.ok) error = messageFor(res.error)
    })
  })

  async function askStop(): Promise<void> {
    error = null
    unmerged = await freshUnmerged(worker)
    confirming = true
  }

  async function askRemove(): Promise<void> {
    error = null
    unmerged = worker.status === 'done' ? await freshUnmerged(worker) : 0
    if (unmerged > 0) removing = 'confirm'
    else await remove()
  }

  async function remove(): Promise<void> {
    removing = 'busy'
    const message = await removeWorker(worker.id)
    if (message) {
      error = message
      removing = null
    }
  }

  async function resume(): Promise<void> {
    continuing = true
    error = null
    const reason = await continueWorker(worker.id)
    continuing = false
    if (reason) error = reason
    else onclose()
  }

  async function stepIn(): Promise<void> {
    error = null
    if (await workerControl.stepIn(worker.id)) {
      workerTerminals.open(worker.id)
      onclose()
    } else error = workerControl.errors[worker.id] ?? null
  }

  async function handBack(): Promise<void> {
    error = null
    if (!(await workerControl.handBack(worker.id))) error = workerControl.errors[worker.id] ?? null
  }

  async function stop(): Promise<void> {
    stopping = true
    error = null
    const res = await window.harness.invoke('workers:stop', { workerId: worker.id })
    stopping = false
    if (!res.ok) {
      error = messageFor(res.error)
      return
    }
    onclose()
  }
</script>

<Modal
  title={name}
  size="lg"
  busy={stopping || removing === 'busy'}
  onsubmit={onclose}
  oncancel={onclose}
>
  <div class="flex max-h-[60vh] flex-col gap-3 overflow-auto text-sm" data-worker-details>
    <p class="text-xs font-semibold tracking-label uppercase {WORKER_TONE_CLASS[status.tone]}">
      {status.label} · <ProviderTag
        runningOn={worker.runningOn}
        model={worker.model}
        showReason
        class="normal-case"
      />
    </p>
    {#if helpers}
      <p
        class="w-fit rounded-sm border border-border px-1.5 py-0.5 font-mono text-xs text-text-muted"
        data-worker-helpers={worker.helpersRunning}
      >
        {helpers}
      </p>
    {/if}
    {#if worker.command}
      <section>
        <h3 class="text-xs tracking-label text-text-muted uppercase">Command</h3>
        <p class="font-mono break-all whitespace-pre-wrap text-text" data-worker-command>
          {worker.command}
        </p>
      </section>
    {/if}
    <section>
      <h3 class="text-xs tracking-label text-text-muted uppercase">Task</h3>
      <p class="whitespace-pre-wrap text-text">{details?.task ?? worker.task}</p>
    </section>
    {#if worker.status === 'failed' && (details?.failureReason ?? worker.failureReason)}
      <section>
        <h3 class="text-xs tracking-label text-text-muted uppercase">Failure reason</h3>
        <ErrorText message={details?.failureReason ?? worker.failureReason ?? ''} />
      </section>
    {/if}
    <section data-worker-tokens>
      <h3 class="flex items-center gap-1.5 text-xs tracking-label text-text-muted uppercase">
        Tokens{#if agentUsage?.inFlight || worker.tokensInFlight}<LiveMark />{/if}
      </h3>
      {#if tokens === null}
        <p><TokenCount value={null} notReported={agentUsage?.recording === 'not-reported'} /></p>
      {:else}
        <dl class="grid grid-cols-[max-content_1fr] gap-x-4 text-xs">
          {#each TOKEN_ROWS as [label, key] (key)}
            <dt class="text-text-muted">{label}</dt>
            <dd class="text-text" data-worker-tokens-row={key}>
              <TokenCount value={tokens[key]} />
            </dd>
          {/each}
        </dl>
        {#if agentUsage}
          <div class="mt-2">
            <SetupSplit
              setup={agentUsage.setup}
              inputTotal={tokens.input +
                tokens.cacheWrite +
                tokens.cacheRead -
                (agentUsage.inFlight
                  ? agentUsage.inFlight.input +
                    agentUsage.inFlight.cacheWrite +
                    agentUsage.inFlight.cacheRead
                  : 0)}
            />
          </div>
        {/if}
      {/if}
    </section>
    <section>
      <h3 class="text-xs tracking-label text-text-muted uppercase">Latest report</h3>
      <p class="whitespace-pre-wrap text-text">
        {details?.lastReport ?? 'No report yet.'}
      </p>
    </section>
    <section>
      <h3 class="text-xs tracking-label text-text-muted uppercase">Changed files</h3>
      {#if details && details.changedFiles.length > 0}
        <ul class="font-mono text-xs text-text" data-changed-files>
          {#each details.changedFiles as file (file)}<li class="break-all">{file}</li>{/each}
        </ul>
      {:else}
        <p class="text-text-muted">No changes yet.</p>
      {/if}
    </section>
    <section>
      <h3 class="text-xs tracking-label text-text-muted uppercase">Working copy</h3>
      {#if details && details.worktreePaths.length > 0}
        <ul class="font-mono text-xs text-text" data-worktree-paths>
          {#each details.worktreePaths as wt (wt.path)}
            <li class="break-all">
              {#if details.worktreePaths.length > 1}<span class="text-text-muted"
                  >{wt.projectName}:
                </span>{/if}{wt.path}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-text-muted">None yet.</p>
      {/if}
    </section>
  </div>
  {#if error}<ErrorText message={error} />{/if}
  {#if confirming}
    <div data-stop-confirm class="flex flex-col gap-1">
      <p class="text-sm text-text">Stop {name}? Its working copy will be removed.</p>
      {#if unmerged > 0}
        <span data-unmerged-warning><ErrorText message={unmergedWarning(unmerged)} /></span>
      {/if}
    </div>
    <div class="flex justify-end gap-2">
      <Button onclick={() => (confirming = false)} disabled={stopping}>Keep running</Button>
      <Button variant="danger" busy={stopping} onclick={() => void stop()}>Stop worker</Button>
    </div>
  {:else if removing === 'confirm'}
    <div data-remove-confirm class="flex flex-col gap-1">
      <p class="text-sm text-text">Remove {name}?</p>
      <ErrorText message={unmergedWarning(unmerged)} />
    </div>
    <div class="flex justify-end gap-2">
      <Button onclick={() => (removing = null)}>Keep</Button>
      <Button variant="danger" onclick={() => void remove()}>Remove worker</Button>
    </div>
  {:else}
    <div class="flex justify-end gap-2">
      {#if REMOVABLE.includes(worker.status)}
        <Button variant="danger" busy={removing === 'busy'} onclick={() => void askRemove()}
          >Remove</Button
        >
      {/if}
      {#if STOPPABLE.includes(worker.status)}
        <Button variant="danger" onclick={() => void askStop()}>Stop</Button>
      {/if}
      {#if canContinue(worker)}
        <Button variant="primary" busy={continuing} onclick={() => void resume()}>Continue</Button>
      {/if}
      {#if worker.userControl}
        <Button
          variant="primary"
          busy={workerControl.busy[worker.id]}
          onclick={() => void handBack()}>Hand back</Button
        >
      {:else if canStepIn(worker)}
        <Button busy={workerControl.busy[worker.id]} onclick={() => void stepIn()}>Step in</Button>
      {/if}
      <Button type="submit">Close</Button>
    </div>
  {/if}
</Modal>
