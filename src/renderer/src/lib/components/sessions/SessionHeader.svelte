<script lang="ts">
  import { tick } from 'svelte'
  import type { SessionHeader } from '@shared/types/session'
  import type { ModelRef, WorkersPref } from '@shared/types/provider'
  import {
    brainText,
    decodeRef,
    decodeWorkers,
    encodeRef,
    encodeWorkers,
    modelGroups,
    readinessOf,
    workersEntries,
    workersText
  } from '../../model-options'
  import { messageFor } from '../../ipc/messages'
  import { activeSession } from '../../stores/active-session.svelte'
  import { models } from '../../stores/models.svelte'
  import { providers } from '../../stores/providers.svelte'
  import { sessionsList } from '../../stores/sessions-list.svelte'
  import AttentionBadge from '../ui/AttentionBadge.svelte'
  import AttentionDialog from '../ui/attention/AttentionDialog.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import ApprovalsMenu from './ApprovalsMenu.svelte'
  import CursorEffort from '../ui/CursorEffort.svelte'
  import HeaderMenu from './HeaderMenu.svelte'
  import Icon from '../ui/Icon.svelte'
  import IconButton from '../ui/IconButton.svelte'
  import Panel from '../ui/Panel.svelte'
  import UsageChip from './UsageChip.svelte'
  import { toasts } from '../../stores/toasts.svelte'

  interface Props {
    header: SessionHeader
    groupName: string
    onback: () => void
    /** Files the session changed; the Review changes button shows it. */
    changedCount?: number
    onreview?: () => void
  }

  let { header, groupName, onback, changedCount = 0, onreview }: Props = $props()

  let editing = $state(false)
  let draft = $state('')
  let error = $state<string | null>(null)
  let input: HTMLInputElement | undefined = $state()

  const requests = $derived(activeSession.queueAttention)

  async function answer(
    requestId: string,
    body:
      | { approve: boolean; always?: boolean }
      | { text: string }
      | { answers: Record<string, string[]> }
      | { decline: true }
  ): Promise<string | null> {
    const err = await activeSession.answerAttention(body, requestId)
    if (err) {
      toasts.show(messageFor(err), 'error')
      return messageFor(err)
    }
    return null
  }

  const modeText = $derived(
    `${header.mode === 'plan_first' ? 'Plan-first' : 'Autonomous'} · Limit ${header.workerLimit}`
  )

  const MODE_OPTIONS = [
    { value: 'mode:plan_first', label: 'Plan-first' },
    { value: 'mode:autonomous', label: 'Autonomous' },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ value: `limit:${n}`, label: `Limit ${n}` }))
  ]

  function chooseMode(value: string): void {
    const [kind, v] = value.split(':')
    if (kind === 'mode') void setConfig({ mode: v as 'plan_first' | 'autonomous' })
    else void setConfig({ workerLimit: Number(v) })
  }

  const ready = $derived(readinessOf(providers.statuses))

  const brainRef = $derived<ModelRef>({
    // While Codex or Cursor is unavailable the brain runs on another provider; the picker keeps showing the stored choice.
    provider:
      header.brainRunningOn?.requestedProvider ?? header.brainRunningOn?.provider ?? 'claude',
    model: header.brainModel
  })
  const brainOptions = $derived(
    modelGroups({
      models: models.lists,
      ready,
      current: brainRef,
      offerCodex: ready.codex === true,
      offerCursor: ready.cursor === true
    })
  )

  const workers = $derived<WorkersPref>(
    header.workers ??
      (header.model === 'auto'
        ? { mode: 'auto' }
        : { mode: 'model', model: { provider: 'claude', model: header.model } })
  )
  const workerOptions = $derived(workersEntries(models.lists, ready, workers))

  async function removeRule(ruleId: string): Promise<void> {
    configError = null
    const res = await window.harness.invoke('sessions:remove-allow-rule', {
      sessionId: header.id,
      ruleId
    })
    if (!res.ok) configError = messageFor(res.error)
  }

  let configError = $state<string | null>(null)
  let tipOpen = $state(false)

  async function setConfig(patch: {
    workers?: WorkersPref
    brainModel?: ModelRef
    mode?: 'plan_first' | 'autonomous'
    workerLimit?: number
    autoApprove?: boolean
  }): Promise<void> {
    configError = null
    const res = await window.harness.invoke('sessions:set-config', {
      sessionId: header.id,
      ...patch
    })
    if (!res.ok) configError = messageFor(res.error)
  }

  interface Chip {
    key: string
    /** Repository name; shown only when the repositories differ. */
    repo: string | null
    text: string
    kind: 'branch' | 'read-only' | 'removed'
  }

  // One chip when every repository shares branch and base, otherwise one per repository.
  const chips = $derived.by((): Chip[] => {
    const branched = header.branches.filter(
      (b) => !b.readOnly && !b.removed && b.branchName !== null
    )
    const label = (b: (typeof branched)[number]): string =>
      b.baseBranch ? `${b.branchName} ← ${b.baseBranch}` : (b.branchName ?? '')
    const out: Chip[] = []
    const first = branched[0]
    const same = first !== undefined && branched.every((b) => label(b) === label(first))
    if (first !== undefined && same) {
      out.push({ key: 'branch', repo: null, text: label(first), kind: 'branch' })
    } else {
      for (const b of branched) {
        out.push({
          key: `branch-${b.projectId}`,
          repo: b.projectName,
          text: label(b),
          kind: 'branch'
        })
      }
    }
    for (const b of header.branches.filter((x) => x.readOnly && !x.removed)) {
      out.push({
        key: `ro-${b.projectId}`,
        repo: b.projectName,
        text: 'Read only',
        kind: 'read-only'
      })
    }
    // A project that left the group keeps its place, labelled in words (not by colour alone).
    for (const b of header.branches.filter((x) => x.removed)) {
      out.push({
        key: `removed-${b.projectName}`,
        repo: b.projectName,
        text: 'Removed',
        kind: 'removed'
      })
    }
    return out
  })

  async function startEdit(): Promise<void> {
    draft = header.name
    error = null
    editing = true
    await tick()
    input?.focus()
    input?.select()
  }

  function cancel(): void {
    editing = false
    error = null
  }

  async function save(): Promise<void> {
    const name = draft.trim()
    if (name === '' || name === header.name) return cancel()
    const res = await window.harness.invoke('sessions:rename', { sessionId: header.id, name })
    if (!res.ok) {
      error = messageFor(res.error)
      return
    }
    activeSession.setName(res.data.name)
    sessionsList.upsert(res.data)
    cancel()
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      void save()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }
</script>

<Panel as="div" class="shrink-0">
  <div class="flex items-center gap-3 px-3 pt-2">
    <Button onclick={onback}>
      <Icon name="chevron" size={16} class="rotate-180" />Sessions
    </Button>
    <div class="flex min-w-[12ch] flex-1 flex-col">
      <span class="truncate text-xs tracking-label text-text-muted uppercase">{groupName}</span>
      {#if editing}
        <input
          bind:this={input}
          bind:value={draft}
          {onkeydown}
          onblur={cancel}
          aria-label="Session name"
          aria-invalid={error ? 'true' : 'false'}
          class="min-h-8 w-full rounded-control border border-border-strong bg-surface-panel px-2 font-display text-base text-text-bright focus:outline-none focus-visible:shadow-focus"
        />
        {#if error}<ErrorText message={error} />{/if}
      {:else}
        <h2
          class="truncate font-display text-base font-semibold text-text-bright"
          title={header.name}
          data-session-name
        >
          {header.name}
        </h2>
      {/if}
    </div>
    {#if !editing}
      <IconButton label="Rename session" icon="edit" onclick={() => void startEdit()} />
    {/if}
    {#if requests.length > 0}
      <AttentionBadge count={requests.length} onclick={() => activeSession.openAttention()} />
    {/if}
  </div>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2" data-header-controls>
    <HeaderMenu
      label="Mode and worker limit"
      text={modeText}
      options={MODE_OPTIONS}
      current={[`mode:${header.mode}`, `limit:${header.workerLimit}`]}
      onselect={chooseMode}
    />
    <HeaderMenu
      label="Brain model"
      text={brainText(brainRef, models.lists, ready)}
      options={brainOptions}
      current={encodeRef(brainRef)}
      onselect={(v) => void setConfig({ brainModel: decodeRef(v) })}
    />
    {#if brainRef.provider === 'cursor'}
      <CursorEffort
        id="header-brain"
        subject="the brain"
        models={models.lists.cursor}
        model={brainRef.model}
        onchange={(model) => void setConfig({ brainModel: { provider: 'cursor', model } })}
      />
    {/if}
    <HeaderMenu
      label="Worker model"
      text={workersText(workers, models.lists, ready)}
      options={workerOptions}
      current={encodeWorkers(workers)}
      onselect={(v) => void setConfig({ workers: decodeWorkers(v) })}
    />
    {#if workers.mode === 'model' && workers.model.provider === 'cursor'}
      <CursorEffort
        id="header-workers"
        models={models.lists.cursor}
        model={workers.model.model}
        onchange={(model) =>
          void setConfig({ workers: { mode: 'model', model: { provider: 'cursor', model } } })}
      />
    {/if}
    <ApprovalsMenu
      id={header.id}
      autoApprove={header.autoApprove}
      rules={header.allowRules}
      onautoapprove={(value) => void setConfig({ autoApprove: value })}
      onremove={(id) => void removeRule(id)}
    />
    {#if header.autoApprove}
      <span
        class="rounded-control border border-attention/55 bg-attention/10 px-2 py-0.5 text-xs font-semibold tracking-label text-attention-text uppercase"
        data-auto-approve-on>Auto-approve on</span
      >
    {/if}
    <UsageChip sessionId={header.id} />
    <span
      class="relative inline-flex"
      role="presentation"
      onmouseenter={() => (tipOpen = true)}
      onmouseleave={() => (tipOpen = false)}
      onfocusin={() => (tipOpen = true)}
      onfocusout={() => (tipOpen = false)}
    >
      <Button
        ariaDisabled={changedCount === 0}
        ariaDescribedby={changedCount === 0 && tipOpen ? 'review-tip' : undefined}
        onclick={() => onreview?.()}>Review changes · {changedCount}</Button
      >
      {#if changedCount === 0 && tipOpen}
        <span
          id="review-tip"
          role="tooltip"
          class="pointer-events-none absolute top-full left-0 z-30 mt-1 rounded-control border border-border-strong bg-surface-panel px-2 py-1 text-xs whitespace-nowrap text-text"
          >No changes yet</span
        >
      {/if}
    </span>
    {#if chips.length > 0}
      <ul class="ml-auto flex flex-wrap items-center gap-2" aria-label="Session branches">
        {#each chips as chip (chip.key)}
          <li
            class="inline-flex items-center gap-1.5 rounded-control border border-border bg-surface-code px-2 py-0.5 text-xs text-text"
            data-branch-chip={chip.kind}
          >
            {#if chip.repo}<span class="text-text-muted">{chip.repo}</span>{/if}
            <span class={chip.kind === 'branch' ? 'font-mono' : 'tracking-label uppercase'}
              >{chip.text}</span
            >
          </li>
        {/each}
      </ul>
    {/if}
  </div>
  {#if configError}<div class="px-3 pb-2"><ErrorText message={configError} /></div>{/if}
</Panel>

<AttentionDialog
  open={activeSession.attentionDialog !== null}
  {requests}
  initialRequestId={activeSession.attentionDialog?.initialRequestId ?? null}
  onApprove={(id) => void answer(id, { approve: true })}
  onDeny={(id) => void answer(id, { approve: false })}
  onAlwaysAllow={(id) => void answer(id, { approve: true, always: true })}
  onAnswer={(id, text) => void answer(id, { text })}
  onAnswerStructured={(id, answers) => answer(id, { answers })}
  onDecline={(id) => answer(id, { decline: true })}
  onClose={() => activeSession.closeAttention()}
/>
