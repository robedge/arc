<script lang="ts">
  import { tick } from 'svelte'
  import type { AllowRuleView } from '@shared/types/session'
  import IconButton from '../ui/IconButton.svelte'
  import Toggle from '../ui/Toggle.svelte'

  interface Props {
    id: string
    autoApprove: boolean
    rules: readonly AllowRuleView[]
    onautoapprove: (value: boolean) => void
    onremove: (ruleId: string) => void
  }

  let { id, autoApprove, rules, onautoapprove, onremove }: Props = $props()

  let open = $state(false)
  let root: HTMLElement | undefined = $state()
  let button: HTMLButtonElement | undefined = $state()
  let checked = $derived(autoApprove)

  async function toggle(): Promise<void> {
    open = !open
    if (!open) return
    await tick()
    root?.querySelector<HTMLElement>('[role="dialog"] input, [role="dialog"] button')?.focus()
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
        id="auto-approve-{id}"
        label="Auto-approve"
        bind:checked
        onchange={() => onautoapprove(checked)}
      />
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
</div>
