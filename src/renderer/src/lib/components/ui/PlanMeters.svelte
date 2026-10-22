<script lang="ts">
  import { providerName } from '@shared/provider-label'
  import type { PlanLimit, ProviderPlan } from '@shared/types/usage'
  import { planUsage } from '../../stores/plan-usage.svelte'
  import { limitSeverity, worstSeverity, type LimitSeverity } from '../../usage/derive'
  import PlanLimitRow from '../usage/PlanLimitRow.svelte'
  import Icon from './Icon.svelte'

  /** One limit as meter text: "5h 42%", or "5h Reset" once its period ended. */
  function limitText(l: PlanLimit): string {
    return `${l.label} ${l.stale ? 'Reset' : `${Math.round(l.usedPercent)}%`}`
  }

  function severityOf(plan: ProviderPlan): LimitSeverity {
    return worstSeverity(
      plan.limits.filter((l) => !l.stale).map((l) => limitSeverity(l.usedPercent))
    )
  }

  /** The fullest limit, for the narrow form. */
  function fullest(plan: ProviderPlan): PlanLimit | undefined {
    const live = plan.limits.filter((l) => !l.stale)
    const pool = live.length > 0 ? live : plan.limits
    return pool.reduce<PlanLimit | undefined>(
      (best, l) => (!best || l.usedPercent > best.usedPercent ? l : best),
      undefined
    )
  }

  function stateText(plan: ProviderPlan): string | null {
    if (plan.state === 'waiting') return 'Waiting for first use'
    if (plan.state === 'not-reported') return 'Not reported'
    return plan.limits.length === 0 ? 'Not reported' : null
  }

  function fullText(plan: ProviderPlan): string {
    const rest = stateText(plan) ?? plan.limits.map(limitText).join(' · ')
    return `${providerName(plan.provider)} · ${rest}`
  }

  function compactText(plan: ProviderPlan): string {
    const rest = stateText(plan)
    if (rest) return `${providerName(plan.provider)} · ${rest}`
    const l = fullest(plan)
    return `${providerName(plan.provider)}${l ? ` · ${limitText(l)}` : ''}`
  }

  let hovered = $state<string | null>(null)
  let focused = $state<string | null>(null)
  let pinned = $state<string | null>(null)
  const openFor = $derived(pinned ?? hovered ?? focused)

  let buttons: Record<string, HTMLButtonElement | undefined> = $state({})

  function close(provider: string): void {
    hovered = null
    focused = null
    pinned = null
    buttons[provider]?.focus()
  }

  function onkeydown(event: KeyboardEvent, provider: string): void {
    if (openFor === provider && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(provider)
    }
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (
      pinned &&
      event.target instanceof Element &&
      !event.target.closest('[data-plan-meter-root]')
    )
      pinned = null
  }

  const now = $derived(Date.now())
</script>

<svelte:window
  onpointerdown={onwindowpointerdown}
  onkeydown={(e) => {
    // A meter opened by hover has no focus inside it, so its own handler never hears Escape.
    if (openFor && e.key === 'Escape') {
      e.preventDefault()
      // Not close(): moving focus to the button would reopen the popover through focusin.
      hovered = focused = pinned = null
    }
  }}
/>

{#if planUsage.meters.length > 0}
  <div class="@container flex min-w-0 flex-1 items-center justify-end gap-2" data-plan-meters>
    {#each planUsage.meters as plan (plan.provider)}
      {@const severity = severityOf(plan)}
      {@const id = `plan-popover-${plan.provider}`}
      <div
        class="no-drag relative shrink-0 select-none"
        role="presentation"
        data-plan-meter-root
        onmouseenter={() => (hovered = plan.provider)}
        onmouseleave={() => (hovered = null)}
        onfocusin={() => (focused = plan.provider)}
        onfocusout={() => (focused = null)}
        onkeydown={(e) => onkeydown(e, plan.provider)}
      >
        <button
          bind:this={buttons[plan.provider]}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={openFor === plan.provider}
          aria-controls={id}
          aria-label={fullText(plan)}
          onclick={() => (pinned = pinned === plan.provider ? null : plan.provider)}
          class="inline-flex min-h-8 items-center gap-1.5 rounded-control border px-2.5 text-xs whitespace-nowrap tabular-nums focus:outline-none focus-visible:shadow-focus {severity ===
          'critical'
            ? 'border-danger text-danger'
            : severity === 'warn'
              ? 'border-attention text-attention'
              : 'border-border text-text-muted hover:border-border-strong'}"
          data-plan-meter={plan.provider}
          data-severity={severity}
          data-plan-meter-state={plan.state}
        >
          {#if severity !== 'ok'}
            <Icon name={severity === 'critical' ? 'error' : 'warning'} size={14} />
            <span class="sr-only">{severity === 'critical' ? 'critical' : 'warning'}</span>
          {/if}
          <span class="@max-[36rem]:hidden" data-plan-full aria-hidden="true">{fullText(plan)}</span
          >
          <span class="hidden @max-[36rem]:inline" data-plan-compact aria-hidden="true"
            >{compactText(plan)}</span
          >
        </button>
        {#if openFor === plan.provider}
          <div
            {id}
            role="dialog"
            aria-label="{providerName(plan.provider)} plan limits"
            class="absolute top-full right-0 z-50 mt-1 min-w-64 rounded-hud border border-border-strong bg-surface-raised p-3 text-sm shadow-glow-accent"
            data-plan-popover
          >
            {#if plan.limits.length > 0}
              <ul class="divide-y divide-border">
                {#each plan.limits as limit (limit.windowId)}
                  <PlanLimitRow {limit} {now} />
                {/each}
              </ul>
            {:else}
              <p class="text-text-muted">{stateText(plan)}</p>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
