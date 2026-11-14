<script lang="ts">
  // Everything that waits for the user, above the message box. Fed only by `session:attention`.
  import { onDestroy, tick, untrack } from 'svelte'
  import type { AttentionView } from '@shared/types/session'
  import { activeSession } from '../../stores/active-session.svelte'
  import RequestPanel from './RequestPanel.svelte'

  /** How long a panel the user was sent to stays outlined. */
  const HIGHLIGHT_MS = 2000
  const FOCUSABLE =
    'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

  /**
   * The Design Preview passes samples (and may start them folded, with a fold of their own); the app
   * leaves both out and gets the live queue and the stored fold.
   */
  let { requests: given, folded: sampleFolded }: { requests?: AttentionView[]; folded?: boolean } =
    $props()
  const uid = $props.id()
  const listId = `attention-list-${uid}`
  const requests = $derived(given ?? activeSession.queueAttention)
  let ownFold = $state(untrack(() => sampleFolded ?? false))
  const folded = $derived(given ? ownFold : activeSession.attentionFolded)
  let region: HTMLElement | undefined = $state()

  function toggle(): void {
    if (given) ownFold = !ownFold
    else activeSession.toggleAttentionFold()
  }

  let highlighted: HTMLElement | null = null
  let timer: ReturnType<typeof setTimeout> | undefined

  function clearHighlight(): void {
    clearTimeout(timer)
    highlighted?.removeAttribute('data-highlight')
    highlighted = null
  }
  onDestroy(clearHighlight)

  // A notification click or a worker card names a panel: bring it into view and outline it for a moment.
  $effect(() => {
    const focus = activeSession.attentionFocus
    if (focus === null || !region) return
    const root = region
    void tick().then(() => {
      const panel =
        focus.requestId === null
          ? null
          : root.querySelector<HTMLElement>(`[data-request-panel="${CSS.escape(focus.requestId)}"]`)
      const target = panel ?? root
      // jsdom has no scrollIntoView.
      if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'nearest' })
      clearHighlight()
      if (!panel) return
      panel.setAttribute('data-highlight', '')
      highlighted = panel
      timer = setTimeout(clearHighlight, HIGHLIGHT_MS)
    })
  })

  // After an answer the panel leaves; focus goes on to its neighbour instead of falling to the page.
  // Plain variables: they are bookkeeping between the two effects, not state to render.
  let renderedIds: string[] = []
  let held: { id: string; index: number } | null = null

  $effect.pre(() => {
    void requests
    const active = document.activeElement
    const panel =
      active && region?.contains(active)
        ? active.closest<HTMLElement>('[data-request-panel]')
        : null
    const id = panel?.dataset.requestPanel
    held = id === undefined ? null : { id, index: renderedIds.indexOf(id) }
  })

  $effect(() => {
    const ids = requests.map((r) => r.id)
    const left = held
    held = null
    renderedIds = ids
    if (!left || ids.includes(left.id)) return
    void tick().then(() => {
      const nextId = ids[left.index] ?? ids[left.index - 1]
      const next =
        nextId === undefined
          ? null
          : region?.querySelector<HTMLElement>(`[data-request-panel="${CSS.escape(nextId)}"]`)
      const control = next?.querySelector<HTMLElement>(FOCUSABLE) ?? null
      ;(control ?? document.getElementById('composer-input'))?.focus()
    })
  })
</script>

{#if requests.length > 0}
  <section
    bind:this={region}
    aria-label="Needs attention"
    class="flex max-h-full min-h-0 flex-col border-t border-border bg-surface-panel"
    data-attention-dock
  >
    <h3
      class="shrink-0 text-xs font-semibold tracking-label text-attention-text uppercase"
      data-attention-heading
    >
      <button
        type="button"
        aria-expanded={!folded}
        aria-controls={listId}
        onclick={toggle}
        class="flex min-h-[var(--size-hit)] w-full items-center gap-2 px-3 text-left uppercase focus:outline-none focus-visible:shadow-focus"
      >
        <span aria-hidden="true" class="inline-block w-3 {folded ? '' : 'rotate-90'}">›</span>
        Needs attention · {requests.length}
      </button>
    </h3>
    <div
      id={listId}
      hidden={folded}
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 pt-1"
      data-attention-list
    >
      {#each requests as request (request.id)}
        <RequestPanel {request} />
      {/each}
    </div>
  </section>
{/if}
