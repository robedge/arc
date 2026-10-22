<script lang="ts">
  import type { WorkerView } from '@shared/types/session'
  import { activeSession } from '../../stores/active-session.svelte'
  import { tick } from 'svelte'
  import { BRAIN_TAB, workerTerminals } from '../../stores/worker-terminals.svelte'
  import { workerControl } from '../../stores/worker-control.svelte'
  import Button from '../ui/Button.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import Modal from '../ui/Modal.svelte'
  import Panel from '../ui/Panel.svelte'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import Composer from './Composer.svelte'
  import Conversation from './Conversation.svelte'
  import StepInBar from './StepInBar.svelte'
  import TerminalPanel from './TerminalPanel.svelte'
  import {
    REMOVABLE,
    canStepIn,
    controlLabel,
    WORKER_STATUS,
    WORKER_TONE_CLASS,
    unmergedWarning,
    workerTitle
  } from './worker-status'
  import { canContinue, continueWorker, freshUnmerged, removeWorker } from './worker-actions'
  import ErrorText from '../ui/ErrorText.svelte'

  interface Props {
    sessionId: string
    workers: readonly WorkerView[]
  }

  let { sessionId, workers }: Props = $props()

  const tabs = $derived(
    workerTerminals.tabs.flatMap((id) => {
      const worker = workers.find((w) => w.id === id)
      return worker ? [{ id, worker, title: workerTitle(worker) }] : []
    })
  )
  const order = $derived([BRAIN_TAB, ...tabs.map((t) => t.id)])
  const current = $derived(tabs.find((t) => t.id === workerTerminals.active) ?? null)
  const activeTab = $derived(current ? current.id : BRAIN_TAB)

  /** Pending Remove confirmation for a Done worker with unmerged commits. */
  let removeAsk = $state<{ id: string; count: number } | null>(null)
  let removeError = $state<string | null>(null)
  let continueError = $state<string | null>(null)
  let continuingId = $state<string | null>(null)

  async function resume(id: string): Promise<void> {
    continuingId = id
    continueError = null
    continueError = await continueWorker(id)
    continuingId = null
  }

  async function askRemove(worker: WorkerView): Promise<void> {
    removeError = null
    const count = worker.status === 'done' ? await freshUnmerged(worker) : 0
    if (count > 0) removeAsk = { id: worker.id, count }
    else await doRemove(worker.id)
  }

  async function doRemove(id: string): Promise<void> {
    removeAsk = null
    removeError = await removeWorker(id)
    if (!removeError) tabEls[BRAIN_TAB]?.focus()
  }

  /** The controlled worker whose tab the user is closing; asks whether to hand it back first. */
  let closeAsk = $state<string | null>(null)
  const closeAskTab = $derived(tabs.find((t) => t.id === closeAsk) ?? null)

  /** Closes the tab, but asks first when the user is in control of its worker. */
  function requestClose(id: string): void {
    if (tabs.find((t) => t.id === id)?.worker.userControl) {
      workerControl.errors[id] = null
      closeAsk = id
      return
    }
    finishClose(id)
  }

  function finishClose(id: string): void {
    closeAsk = null
    workerTerminals.close(id)
    tabEls[BRAIN_TAB]?.focus()
  }

  async function handBackAndClose(id: string): Promise<void> {
    if (await workerControl.handBack(id)) finishClose(id)
  }

  /** The Step in button's wrapper: Hand back returns focus to the button inside it. */
  let stepInEl = $state<HTMLElement | undefined>()

  $effect(() => {
    const pending = workerControl.pendingFocus
    if (!stepInEl || pending?.target !== 'step-in' || pending.workerId !== workerTerminals.active)
      return
    workerControl.clearFocus()
    void tick().then(() => stepInEl?.querySelector('button')?.focus())
  })

  let tabEls = $state<Record<string, HTMLElement | undefined>>({})

  function focusTab(id: string | undefined): void {
    if (id === undefined) return
    workerTerminals.select(id)
    tabEls[id]?.focus()
  }

  function onkeydown(event: KeyboardEvent, id: string): void {
    const at = order.indexOf(id)
    if (event.key === 'ArrowRight') focusTab(order[(at + 1) % order.length])
    else if (event.key === 'ArrowLeft') focusTab(order[(at - 1 + order.length) % order.length])
    else if (event.key === 'Home') focusTab(order[0])
    else if (event.key === 'End') focusTab(order[order.length - 1])
    else if (event.key === 'Delete' && id !== BRAIN_TAB) {
      requestClose(id)
    } else return
    event.preventDefault()
  }

  const tabClass = (selected: boolean): string =>
    `min-h-[var(--size-hit)] px-3 text-sm focus:outline-none focus-visible:shadow-focus ${
      selected ? 'text-text' : 'text-text-muted hover:text-text'
    }`
</script>

<div
  class="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-2"
  data-conversation-tabs
>
  <div
    role="tablist"
    aria-label="Conversation"
    class="flex min-w-0 items-center gap-1 overflow-x-auto"
  >
    <span
      role="presentation"
      class="flex shrink-0 items-center border-b-2 {activeTab === BRAIN_TAB
        ? 'border-accent'
        : 'border-transparent'}"
    >
      <button
        type="button"
        role="tab"
        id="tab-{BRAIN_TAB}"
        aria-selected={activeTab === BRAIN_TAB}
        aria-controls="panel-{BRAIN_TAB}"
        tabindex={activeTab === BRAIN_TAB ? 0 : -1}
        bind:this={tabEls[BRAIN_TAB]}
        onclick={() => workerTerminals.select(BRAIN_TAB)}
        onkeydown={(e) => onkeydown(e, BRAIN_TAB)}
        class={tabClass(activeTab === BRAIN_TAB)}>Brain</button
      >
    </span>
    {#each tabs as tab (tab.id)}
      <span
        role="presentation"
        class="flex shrink-0 items-center border-b-2 {activeTab === tab.id
          ? 'border-accent'
          : 'border-transparent'}"
      >
        <button
          type="button"
          role="tab"
          id="tab-{tab.id}"
          aria-selected={activeTab === tab.id}
          aria-controls="panel-{tab.id}"
          tabindex={activeTab === tab.id ? 0 : -1}
          bind:this={tabEls[tab.id]}
          onclick={() => workerTerminals.select(tab.id)}
          onkeydown={(e) => onkeydown(e, tab.id)}
          class={tabClass(activeTab === tab.id)}>{tab.title}</button
        >
        <IconButton label="Close {tab.title}" icon="close" onclick={() => requestClose(tab.id)} />
      </span>
    {/each}
  </div>

  {#if current}
    {@const status = WORKER_STATUS[current.worker.status]}
    {@const control = controlLabel(current.worker)}
    <div
      role="tabpanel"
      id="panel-{current.id}"
      aria-labelledby="tab-{current.id}"
      class="min-h-0 min-w-0"
      data-terminal-tab={current.id}
    >
      <Panel class="h-full min-h-0 min-w-0">
        <div class="flex h-full min-h-0 min-w-0 flex-col">
          <div
            class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2"
            data-terminal-header
          >
            <span class="min-w-0 truncate text-sm font-medium text-text">{current.title}</span>
            <span
              class="shrink-0 text-xs font-semibold tracking-label uppercase {WORKER_TONE_CLASS[
                status.tone
              ]}">{status.label}</span
            >
            {#if control}
              <span
                class="shrink-0 rounded-sm border border-attention/55 bg-attention/10 px-1.5 py-0.5 text-xs font-semibold tracking-label text-attention-text uppercase"
                data-worker-control={current.worker.userControl}>{control}</span
              >
            {/if}
            <ProviderTag
              runningOn={current.worker.runningOn}
              model={current.worker.model}
              class="min-w-0 truncate"
            />
            <span class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
              {#if REMOVABLE.includes(current.worker.status)}
                <Button variant="danger" onclick={() => void askRemove(current.worker)}
                  >Remove</Button
                >
              {/if}
              {#if canContinue(current.worker)}
                <Button
                  variant="primary"
                  busy={continuingId === current.id}
                  onclick={() => void resume(current.id)}>Continue</Button
                >
              {/if}
              {#if current.worker.userControl}
                <Button
                  variant="primary"
                  busy={workerControl.busy[current.id]}
                  onclick={() => void workerControl.handBack(current.id)}>Hand back</Button
                >
              {:else if canStepIn(current.worker)}
                <span bind:this={stepInEl}
                  ><Button
                    busy={workerControl.busy[current.id]}
                    onclick={() => void workerControl.stepIn(current.id)}>Step in</Button
                  ></span
                >
              {/if}
              <Button onclick={() => workerTerminals.showDetails(current.id)}>Details</Button>
            </span>
          </div>
          {#if removeAsk && removeAsk.id === current.id}
            <div
              class="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm"
              data-remove-confirm
            >
              <span class="text-text">Remove {current.title}?</span>
              <ErrorText message={unmergedWarning(removeAsk.count)} />
              <span class="ml-auto flex gap-2">
                <Button onclick={() => (removeAsk = null)}>Keep</Button>
                <Button variant="danger" onclick={() => void doRemove(current.id)}
                  >Remove worker</Button
                >
              </span>
            </div>
          {/if}
          {#if continueError}<div class="px-3 py-1"><ErrorText message={continueError} /></div>{/if}
          {#if removeError}<div class="px-3 py-1"><ErrorText message={removeError} /></div>{/if}
          {#if !current.worker.userControl && workerControl.errors[current.id]}
            <div class="px-3 py-1">
              <ErrorText message={workerControl.errors[current.id] ?? ''} />
            </div>
          {/if}
          {#key current.id}
            {@const buffer = workerTerminals.bufferFor(current.id)}
            {#if buffer}
              <TerminalPanel {buffer} label="{current.title} output" />
            {/if}
          {/key}
          {#if current.worker.userControl}
            <StepInBar
              {sessionId}
              workerId={current.id}
              label={current.title}
              replying={current.worker.controlReplying === true}
            />
          {/if}
        </div>
      </Panel>
    </div>
  {:else}
    <div
      role="tabpanel"
      id="panel-{BRAIN_TAB}"
      aria-labelledby="tab-{BRAIN_TAB}"
      class="min-h-0 min-w-0"
    >
      <Conversation>
        {#snippet footer()}
          {#key sessionId}
            <Composer {sessionId} brainState={activeSession.brainState} />
          {/key}
        {/snippet}
      </Conversation>
    </div>
  {/if}
</div>

{#if closeAskTab}
  {@const askId = closeAskTab.id}
  <Modal
    title="Hand {closeAskTab.title} back to the brain?"
    busy={workerControl.busy[askId]}
    onsubmit={() => void handBackAndClose(askId)}
    oncancel={() => (closeAsk = null)}
  >
    <p class="text-sm text-text-muted">
      Keep it paused leaves the worker waiting for you; reopen its tab to carry on or hand it back.
    </p>
    {#if workerControl.errors[askId]}<ErrorText message={workerControl.errors[askId] ?? ''} />{/if}
    <div class="flex justify-end gap-2">
      <Button onclick={() => (closeAsk = null)} disabled={workerControl.busy[askId]}>Cancel</Button>
      <Button onclick={() => finishClose(askId)} disabled={workerControl.busy[askId]}
        >Keep it paused</Button
      >
      <Button type="submit" variant="primary" busy={workerControl.busy[askId]}>Hand back</Button>
    </div>
  </Modal>
{/if}
