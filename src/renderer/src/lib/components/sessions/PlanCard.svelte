<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import type { ModelRef, ProviderId, WorkersPref } from '@shared/types/provider'
  import type { PlanView } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { cursorGroups, readinessOf, type PickerEntry } from '../../model-options'
  import { motion } from '../../stores/motion.svelte'
  import { models } from '../../stores/models.svelte'
  import { providers } from '../../stores/providers.svelte'
  import Button from '../ui/Button.svelte'
  import CursorEffort from '../ui/CursorEffort.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Panel from '../ui/Panel.svelte'
  import ProviderTag from '../ui/ProviderTag.svelte'
  import Select from '../ui/Select.svelte'
  import { commandLabel } from './worker-status'

  interface Props {
    plan: PlanView
    /** The header's worker model: 'auto' or the model forced onto every worker. */
    workerModel: string
    /** The header's Workers pin; read from `workerModel` when absent. */
    workers?: WorkersPref
  }

  let { plan, workerModel, workers }: Props = $props()

  const FALLBACK_MODEL = 'sonnet'

  const pin = $derived<WorkersPref>(
    workers ??
      (workerModel === 'auto'
        ? { mode: 'auto' }
        : { mode: 'model', model: { provider: 'claude', model: workerModel } })
  )
  /** The header fixes every worker's provider and model. */
  const forced = $derived(pin.mode === 'model')
  const pinned = $derived(pin.mode !== 'auto')
  const ready = $derived(readinessOf(providers.statuses))
  const proposed = $derived(plan.status === 'proposed')
  const waiting = $derived(proposed && plan.changesRequested)

  // Choices the user made; a worker without one shows the brain's proposal.
  let picked = $state<Record<string, { provider: ProviderId; model: string }>>({})
  let busy = $state(false)
  let error = $state<string | null>(null)

  type Worker = PlanView['workers'][number]

  function defaultModel(provider: ProviderId): string {
    const list = models.lists[provider]
    return (list.find((m) => m.isDefault) ?? list[0])?.ref.model ?? FALLBACK_MODEL
  }

  function providerOf(w: Worker): ProviderId {
    if (pin.mode === 'model') return pin.model.provider
    if (pin.mode === 'provider') return pin.provider
    return (
      picked[w.name]?.provider ??
      (plan.status === 'approved' ? (w.approvedProvider ?? w.provider) : undefined) ??
      w.provider ??
      'claude'
    )
  }

  function modelOf(w: Worker): string {
    if (pin.mode === 'model') return pin.model.model
    const choice = picked[w.name]
    if (choice) return choice.model
    const provider = providerOf(w)
    if (plan.status === 'approved' && w.approvedModel) return w.approvedModel
    if (w.model && (w.provider ?? 'claude') === provider) return w.model
    return defaultModel(provider)
  }

  function pickProvider(w: Worker, provider: ProviderId): void {
    picked = { ...picked, [w.name]: { provider, model: defaultModel(provider) } }
  }

  function pickModel(w: Worker, model: string): void {
    picked = { ...picked, [w.name]: { provider: providerOf(w), model } }
  }

  function providerOptions(w: Worker): { value: string; label: string }[] {
    const current = providerOf(w)
    const out = [{ value: 'claude', label: providerName('claude') }]
    for (const provider of ['codex', 'cursor'] as const) {
      if (ready[provider] || current === provider) {
        out.push({
          value: provider,
          label: `${providerName(provider)}${ready[provider] ? '' : ' (unavailable)'}`
        })
      }
    }
    return out
  }

  function modelOptions(w: Worker): PickerEntry[] {
    const provider = providerOf(w)
    if (provider === 'cursor') {
      // Rows are base models; the Effort control picks the variant.
      return cursorGroups(models.lists.cursor, modelOf(w)).map((g) => ({
        group: g.title,
        options: g.rows.map((r) => ({ value: r.value, label: r.label }))
      }))
    }
    const out = models.lists[provider].map((m) => ({ value: m.ref.model, label: m.label }))
    const current = modelOf(w)
    if (!out.some((o) => o.value === current)) out.unshift({ value: current, label: current })
    return out
  }

  const pinHintId = $derived(`plan-${plan.id}-pin`)
  const pinHint = $derived(proposed && pinned)

  const TAG: Partial<Record<PlanView['status'], string>> = {
    approved: 'Approved',
    replaced: 'Replaced',
    rejected: 'Rejected'
  }

  let actions: HTMLDivElement | undefined = $state()

  // A plan that needs a decision is brought fully into view, even if the reader scrolled up.
  // The layout can still shift right after it lands (the card reflows, or the session header grows and shrinks the conversation),
  // so the card keeps itself in view for a short settling window.
  const SETTLE_MS = 1500

  $effect(() => {
    void waiting
    const el = actions
    if (!proposed || !el || typeof el.scrollIntoView !== 'function') return
    const reveal = (): void => {
      el.scrollIntoView({ block: 'nearest', behavior: motion.reduced ? 'auto' : 'smooth' })
    }
    reveal()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reveal)
    observer.observe(el.closest('[data-plan-card]') ?? el)
    const scroller = el.closest('[data-conversation]')
    if (scroller) observer.observe(scroller)
    const stop = setTimeout(() => observer.disconnect(), SETTLE_MS)
    return () => {
      clearTimeout(stop)
      observer.disconnect()
    }
  })

  async function decide(decision: 'approve' | 'ask-changes' | 'reject'): Promise<void> {
    busy = true
    error = null
    const refs: Record<string, ModelRef> = {}
    if (decision === 'approve' && !forced) {
      for (const w of plan.workers) refs[w.name] = { provider: providerOf(w), model: modelOf(w) }
    }
    const res = await window.harness.invoke('sessions:plan-decision', {
      sessionId: plan.sessionId,
      planId: plan.id,
      decision,
      ...(decision === 'approve' && !forced ? { models: refs } : {})
    })
    busy = false
    if (!res.ok) {
      error = messageFor(res.error)
      return
    }
    if (decision === 'ask-changes') document.getElementById('composer-input')?.focus()
  }
</script>

<Panel
  as="div"
  title="Plan"
  tone={proposed ? 'accent' : 'default'}
  class="w-full max-w-[85%] min-w-0 shrink-0 self-start"
  data-plan-card={plan.status}
>
  <div class="flex flex-col gap-3 px-3 py-3">
    {#if TAG[plan.status]}
      <span
        class="self-start text-xs font-semibold tracking-label uppercase {plan.status === 'approved'
          ? 'text-success'
          : 'text-text-faint'}"
        data-plan-tag>{TAG[plan.status]}</span
      >
    {/if}
    {#if pinHint}
      <p id={pinHintId} class="text-xs text-text-muted" data-plan-pin-hint>
        Set by Workers in the header
      </p>
    {/if}
    <ul class="flex flex-col gap-3">
      {#each plan.workers as w, i (w.name)}
        <li
          class="flex flex-col gap-1 border-b border-border pb-3 last:border-b-0 last:pb-0"
          data-plan-worker
        >
          <span class="text-sm font-medium text-text">{w.name}</span>
          <span class="text-sm text-text-muted"
            >{#if w.command}<span
                class="mr-1 rounded-sm bg-surface-raised px-1 py-0.5 font-mono text-xs text-text"
                title={w.command}
                data-plan-command>{commandLabel(w.command)}</span
              >{/if}{w.task}</span
          >
          {#if w.runningOn}<ProviderTag runningOn={w.runningOn} data-plan-provider />{/if}
          {#if w.repos.length > 0}
            <span class="font-mono text-xs text-text-muted">{w.repos.join(', ')}</span>
          {/if}
          <div class="flex flex-wrap gap-2">
            <div class="max-w-48 min-w-32 flex-1">
              <Select
                id="plan-{plan.id}-provider-{i}"
                label="Provider for {w.name}"
                options={providerOptions(w)}
                disabled={!proposed || pinned || busy}
                describedby={pinHint ? pinHintId : undefined}
                bind:value={() => providerOf(w), (v) => pickProvider(w, v as ProviderId)}
              />
            </div>
            <div class="max-w-48 min-w-32 flex-1">
              <Select
                id="plan-{plan.id}-model-{i}"
                label="Model for {w.name}"
                options={modelOptions(w)}
                disabled={!proposed || forced || busy}
                describedby={forced && pinHint ? pinHintId : undefined}
                bind:value={() => modelOf(w), (v) => pickModel(w, v)}
              />
            </div>
            {#if providerOf(w) === 'cursor'}
              <CursorEffort
                id="plan-{plan.id}-{i}"
                subject={w.name}
                models={models.lists.cursor}
                model={modelOf(w)}
                disabled={!proposed || forced || busy}
                onchange={(model) => pickModel(w, model)}
              />
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    {#if waiting}
      <p class="text-sm text-attention" role="status">Waiting for your changes</p>
    {/if}
    {#if error}<ErrorText message={error} />{/if}
    <div class="flex flex-wrap gap-2" bind:this={actions}>
      <Button variant="primary" disabled={!proposed} {busy} onclick={() => void decide('approve')}
        >Approve</Button
      >
      <Button disabled={!proposed || waiting || busy} onclick={() => void decide('ask-changes')}
        >Ask for changes</Button
      >
      <Button variant="danger" disabled={!proposed || busy} onclick={() => void decide('reject')}
        >Reject</Button
      >
    </div>
  </div>
</Panel>
