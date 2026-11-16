<script lang="ts">
  import { tick } from 'svelte'
  import type { AllowRuleView } from '@shared/types/session'
  import IconButton from '../ui/IconButton.svelte'
  import Toggle from '../ui/Toggle.svelte'
  import SkipApprovalsDialog from './SkipApprovalsDialog.svelte'

  interface Props {
    id: string
    autoApprove: boolean
    skipApprovals?: boolean
    rules: readonly AllowRuleView[]
    onautoapprove: (value: boolean) => void
    onskipapprovals?: (value: boolean) => void
    onremove: (ruleId: string) => void
  }

  let {
    id,
    autoApprove,
    skipApprovals = false,
    rules,
    onautoapprove,
    onskipapprovals,
    onremove
  }: Props = $props()

  let open = $state(false)
  let root: HTMLElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()
  // While skip is on, Auto-approve reads as on and locked; the stored value is never written from here.
  let checked = $derived(autoApprove || skipApprovals)
  let skipChecked = $derived(skipApprovals)
  let confirmingSkip = $state(false)

  function onskipchange(): void {
    if (skipChecked) {
      // Turning on needs the warning first: the switch stays off until the user confirms. The menu
      // closes so the warning is the only thing on screen (the menu sits above the modal scrim).
      skipChecked = false
      open = false
      confirmingSkip = true
    } else {
      onskipapprovals?.(false)
    }
  }

  async function toggle(): Promise<void> {
    open = !open
    if (!open) return
    await tick()
    root?.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus()
  }

  async function endConfirm(): Promise<void> {
    confirmingSkip = false
    await tick()
    button?.focus()
  }

  function close(): void {
    open = false
    button?.focus()
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (open && event.target instanceof Node && !root?.contains(event.target)) open = false
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<div bind:this={root} class="relative shrink-0" {onkeydown} role="presentation">
  <button
    bind:this={button}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label="Approvals"
    onclick={() => void toggle()}
    class="inline-flex min-h-[var(--size-hit)] items-center rounded-control border border-border px-3 text-xs tracking-label text-text-muted uppercase hover:border-border-strong focus:outline-none focus-visible:shadow-focus"
    >Approvals{rules.length > 0 ? ` · ${rules.length}` : ''}</button
  >
  {#if open}
    <div
      role="dialog"
      aria-label="Approvals"
      class="absolute left-0 z-20 mt-1 flex w-80 max-w-[90vw] flex-col gap-2 rounded-hud border border-border-strong bg-surface-panel p-3"
    >
      <Toggle
        id="skip-approvals-{id}"
        label="Skip all approvals"
        bind:checked={skipChecked}
        onchange={onskipchange}
      />
      <div
        title={skipApprovals ? 'Covered by Skip all approvals' : undefined}
        aria-describedby={skipApprovals ? `auto-approve-covered-${id}` : undefined}
      >
        <Toggle
          id="auto-approve-{id}"
          label="Auto-approve"
          bind:checked
          disabled={skipApprovals}
          onchange={() => onautoapprove(checked)}
        />
        {#if skipApprovals}
          <span id="auto-approve-covered-{id}" class="sr-only">Covered by Skip all approvals</span>
        {/if}
      </div>
      <p class="text-xs text-text-muted">Pushes and merge requests always ask</p>
      <h3 class="text-xs tracking-label text-text-muted uppercase">Allow rules ({rules.length})</h3>
      {#if rules.length === 0}
        <p class="text-sm text-text-muted">No allow rules in this session.</p>
      {:else}
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          {#each rules as rule (rule.id)}
            <li class="flex items-center justify-between gap-2" data-allow-rule={rule.id}>
              <code class="min-w-0 flex-1 font-mono text-sm break-words text-text">{rule.text}</code
              >
              <IconButton
                label="Remove rule {rule.text}"
                icon="close"
                onclick={() => onremove(rule.id)}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  {#if confirmingSkip}
    <SkipApprovalsDialog
      scope="session"
      onconfirm={() => {
        void endConfirm()
        onskipapprovals?.(true)
      }}
      oncancel={() => void endConfirm()}
    />
  {/if}
</div>
