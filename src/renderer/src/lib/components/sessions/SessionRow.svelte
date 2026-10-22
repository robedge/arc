<script lang="ts">
  import type { SessionListStatus, SessionSummary } from '@shared/types/session'
  import { relativeTime } from '../../relative-time'
  import IconButton from '../ui/IconButton.svelte'
  import Menu from '../ui/Menu.svelte'
  import MenuItem from '../ui/MenuItem.svelte'

  interface Props {
    session: SessionSummary
    onopen: (sessionId: string) => void
    onrename?: (sessionId: string) => void
    ondelete?: (sessionId: string) => void
  }

  let { session, onopen, onrename, ondelete }: Props = $props()

  const STATUS_WORD: Record<SessionListStatus, string> = {
    working: 'Working',
    'needs-attention': 'Needs attention',
    idle: 'Idle',
    stopped: 'Stopped'
  }
  const STATUS_TONE: Record<SessionListStatus, string> = {
    working: 'text-accent',
    'needs-attention': 'text-attention',
    idle: 'text-text-muted',
    stopped: 'text-text-faint'
  }

  let menuOpen = $state(false)
  let root: HTMLElement | undefined = $state()

  function trigger(): HTMLElement | null {
    return root?.querySelector<HTMLElement>('[data-session-menu-button]') ?? null
  }

  function closeMenu(): void {
    menuOpen = false
  }

  function onwindowpointerdown(event: PointerEvent): void {
    if (!menuOpen) return
    const target = event.target
    if (target instanceof Node && root?.contains(target)) return
    closeMenu()
  }

  function choose(action: ((sessionId: string) => void) | undefined): void {
    // The menu item unmounts with the menu: park focus on its trigger so the dialog restores it on close.
    trigger()?.focus()
    closeMenu()
    action?.(session.id)
  }

  function onmenukeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      trigger()?.focus()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(root?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1
    items.at(next % items.length)?.focus()
  }
</script>

<svelte:window onpointerdown={onwindowpointerdown} />

<div bind:this={root} class="relative flex items-center gap-1" data-session-menu-root>
  <button
    type="button"
    onclick={() => onopen(session.id)}
    data-session-row
    class="flex min-h-[var(--size-hit)] min-w-0 flex-1 items-center justify-between gap-3 rounded-control border border-border bg-surface-raised px-3 py-2 text-left transition-shadow duration-(--duration-fast) hover:border-border-strong focus:outline-none focus-visible:shadow-focus"
  >
    <span class="min-w-0 flex-1 truncate text-sm font-medium text-text">{session.name}</span>
    <span class="shrink-0 text-xs text-text-muted">{relativeTime(session.lastActiveAt)}</span>
    <span
      class="shrink-0 text-xs font-semibold tracking-label uppercase {STATUS_TONE[
        session.listStatus
      ]}"
      data-session-status>{STATUS_WORD[session.listStatus]}</span
    >
  </button>
  <IconButton
    data-session-menu-button
    label="Session options"
    icon="more"
    aria-haspopup="menu"
    aria-expanded={menuOpen}
    onclick={() => (menuOpen = !menuOpen)}
  />
  {#if menuOpen}
    <Menu label="Session options" class="right-0" onkeydown={onmenukeydown}>
      <MenuItem onclick={() => choose(onrename)}>Rename</MenuItem>
      <MenuItem danger onclick={() => choose(ondelete)}>Delete Session</MenuItem>
    </Menu>
  {/if}
</div>
