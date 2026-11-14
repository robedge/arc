<script module lang="ts">
  /** Where each session's conversation was scrolled to, for when it is mounted again. */
  const scrollMemory: Record<string, { top: number; stuck: boolean } | undefined> = {}
</script>

<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import Panel from '../ui/Panel.svelte'
  import Button from '../ui/Button.svelte'
  import type { Snippet } from 'svelte'
  import PlanCard from './PlanCard.svelte'
  import ContinueWorkersPrompt from './ContinueWorkersPrompt.svelte'
  import MessageBubble from './MessageBubble.svelte'
  import { dockCap } from '../../dock-cap'

  /** `dock` sits between the message list and the footer, outside the scrolling list. */
  let { footer, dock }: { footer?: Snippet; dock?: Snippet } = $props()

  const STICK_THRESHOLD_PX = 48

  let scroller: HTMLDivElement | undefined = $state()
  let dockEl: HTMLDivElement | undefined = $state()
  let seenBump = activeSession.forceBottom
  const memoryKey = activeSession.sessionId
  let stuck = $state(
    untrack(() => (memoryKey ? scrollMemory[memoryKey]?.stuck : undefined) ?? true)
  )

  function remember(): void {
    if (memoryKey && scroller) scrollMemory[memoryKey] = { top: scroller.scrollTop, stuck }
  }

  onMount(() => {
    const saved = memoryKey ? scrollMemory[memoryKey] : undefined
    if (saved && !saved.stuck && scroller) scroller.scrollTop = saved.top
    return remember
  })

  function measure(): void {
    if (!scroller) return
    stuck = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= STICK_THRESHOLD_PX
    remember()
  }

  function toBottom(): void {
    if (!scroller) return
    scroller.scrollTop = scroller.scrollHeight
    stuck = true
  }

  async function loadEarlier(): Promise<void> {
    if (!scroller) return
    const before = scroller.scrollHeight
    const top = scroller.scrollTop
    await activeSession.loadEarlier()
    await tick()
    // Keep the message the reader was looking at in place.
    if (scroller) scroller.scrollTop = top + (scroller.scrollHeight - before)
  }

  $effect(() => {
    void activeSession.messages
    if (untrack(() => stuck)) void tick().then(toBottom)
  })

  // When the dock grows or shrinks the list changes height; a reader at the bottom stays there.
  $effect(() => {
    if (!dockEl || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (untrack(() => stuck)) toBottom()
    })
    observer.observe(dockEl)
    return () => observer.disconnect()
  })

  // The dock shows its first panel in full: its height limit is raised from half to what heading and
  // first panel need (up to 80%). Without sizes (jsdom, hidden) the class's 50% stays.
  function applyDockCap(): void {
    if (!dockEl) return
    const host = dockEl.parentElement
    const heading = dockEl.querySelector<HTMLElement>('[data-attention-heading]')
    const first = dockEl.querySelector<HTMLElement>('[data-request-panel]')
    const list = dockEl.querySelector<HTMLElement>('[data-attention-list]')
    let paddings = 0
    if (list) {
      const style = getComputedStyle(list)
      paddings = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    }
    // The dock's own top border.
    paddings += 1
    const cap = dockCap(
      host?.clientHeight ?? 0,
      heading?.offsetHeight ?? 0,
      first?.offsetHeight ?? 0,
      paddings
    )
    const next = cap === null ? '' : `${Math.round(cap)}px`
    if (dockEl.style.maxHeight !== next) dockEl.style.maxHeight = next
  }

  $effect(() => {
    if (!dockEl || typeof ResizeObserver === 'undefined') return
    const root = dockEl
    const sizes = new ResizeObserver(applyDockCap)
    const watch = (): void => {
      sizes.disconnect()
      if (root.parentElement) sizes.observe(root.parentElement)
      sizes.observe(root)
      for (const el of root.querySelectorAll('[data-attention-heading], [data-request-panel]')) {
        sizes.observe(el)
      }
      applyDockCap()
    }
    // Panels come and go and the list hides when folded: watch the ones there now.
    const changes = new MutationObserver(watch)
    changes.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden']
    })
    watch()
    return () => {
      sizes.disconnect()
      changes.disconnect()
    }
  })

  $effect(() => {
    const bump = activeSession.forceBottom
    // Only a send while mounted; mounting again must not undo the restored position.
    if (bump !== seenBump) {
      seenBump = bump
      void tick().then(toBottom)
    }
  })
</script>

<Panel class="h-full min-h-0 min-w-0">
  <div class="flex h-full min-h-0 min-w-0 flex-col">
    <div class="relative flex min-h-0 min-w-0 flex-1 flex-col" data-scroller-region>
      <div
        bind:this={scroller}
        onscroll={measure}
        class="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto p-3"
        data-conversation
        role="log"
        aria-label="Conversation"
      >
        {#if activeSession.hasEarlier}
          <div class="flex shrink-0 justify-center">
            <Button onclick={() => void loadEarlier()} disabled={activeSession.loadingEarlier}
              >Load earlier</Button
            >
          </div>
        {/if}
        {#each activeSession.messages as message (message.id)}
          {@const plan = message.planId ? activeSession.plans[message.planId] : undefined}
          {#if plan}
            <PlanCard {plan} workers={activeSession.header?.workers ?? { mode: 'auto' }} />
          {:else if message.prompt?.kind === 'continue-workers'}
            <ContinueWorkersPrompt {message} prompt={message.prompt} />
          {:else}
            <MessageBubble {message} />
          {/if}
        {/each}
      </div>
      {#if !stuck}
        <div class="pointer-events-none absolute right-4 bottom-2 left-4 flex justify-center">
          <span class="pointer-events-auto"><Button onclick={toBottom}>Jump to latest</Button></span
          >
        </div>
      {/if}
    </div>
    {#if dock}
      <div bind:this={dockEl} class="flex max-h-[50%] min-h-0 shrink-0 flex-col" data-dock-region>
        {@render dock()}
      </div>
    {/if}
    <div data-footer-region>{@render footer?.()}</div>
  </div>
</Panel>
