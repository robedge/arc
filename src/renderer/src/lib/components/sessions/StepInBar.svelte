<script lang="ts">
  import { tick } from 'svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { commands } from '../../stores/commands.svelte'
  import { workerControl } from '../../stores/worker-control.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import RequestPanel from './RequestPanel.svelte'
  import CommandMenu from './CommandMenu.svelte'
  import { commandOptionId } from './command-filter'
  import { SlashMenu } from './slash-menu.svelte'

  interface Props {
    sessionId: string
    workerId: string
    /** The worker's name as shown on its tab, e.g. "W1 · api-retry". */
    label: string
    /** A turn is running: Escape interrupts it. */
    replying: boolean
  }

  let { sessionId, workerId, label, replying }: Props = $props()

  const inputId = $derived(`worker-input-${workerId}`)
  const menuId = $derived(`command-menu-worker-${workerId}`)
  const text = $derived(workerControl.draftFor(workerId))
  const error = $derived(workerControl.errors[workerId] ?? null)
  let sending = $state(false)
  let input: HTMLTextAreaElement | undefined = $state()

  const menu = new SlashMenu({
    sessionId: () => sessionId,
    text: () => workerControl.draftFor(workerId),
    setText: (next) => workerControl.setDraft(workerId, next)
  })

  // Prefetch so the list is ready by the time the user types `/`.
  $effect(() => commands.ensure(sessionId))

  // Step in lands here: focus the input once it exists.
  $effect(() => {
    const pending = workerControl.pendingFocus
    if (pending?.workerId !== workerId || pending.target !== 'input') return
    workerControl.clearFocus()
    void tick().then(() => input?.focus())
  })

  const pinned = $derived(activeSession.terminalAttentionFor(workerId))
  const canSend = $derived(text.trim().length > 0 && !sending)

  function oninput(event: Event): void {
    workerControl.setDraft(workerId, (event.currentTarget as HTMLTextAreaElement).value)
    menu.oninput()
  }

  async function send(): Promise<void> {
    if (!canSend) return
    sending = true
    try {
      await workerControl.sendInput(workerId, text.trimEnd())
    } finally {
      sending = false
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (menu.open && menu.onKey(event)) return
    if (event.key === 'Escape') {
      if (replying) {
        event.preventDefault()
        void workerControl.interrupt(workerId)
      }
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    void send()
  }
</script>

<div class="flex min-w-0 shrink-0 flex-col gap-2 border-t border-border p-3" data-step-in-bar>
  {#if pinned.length > 0}
    <div
      role="group"
      aria-label="Needs your answer"
      class="flex max-h-[min(40vh,20rem)] flex-col gap-2 overflow-y-auto"
      data-pinned-requests
    >
      <p class="text-xs font-semibold tracking-label text-attention-text uppercase">
        Needs your answer
      </p>
      {#each pinned as request (request.id)}
        <RequestPanel {request} />
      {/each}
    </div>
  {/if}
  {#if error}<ErrorText message={error} />{/if}
  <div class="relative flex items-end gap-2">
    {#if menu.open}
      <CommandMenu
        id={menuId}
        status={menu.catalogue.status}
        commands={menu.matches}
        activeIndex={menu.activeIndex}
        onpick={(command) => menu.pick(command)}
        onretry={() => void commands.load(sessionId)}
      />
    {/if}
    <label for={inputId} class="sr-only">Message to {label}</label>
    <div class="relative flex min-w-0 flex-1">
      <textarea
        id={inputId}
        bind:this={input}
        value={text}
        {oninput}
        {onkeydown}
        rows={2}
        role="combobox"
        aria-expanded={menu.open}
        aria-controls={menu.hasOptions ? menuId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={menu.hasOptions
          ? commandOptionId(menuId, menu.activeIndex)
          : undefined}
        placeholder="Message {label}"
        class="max-h-40 min-h-[var(--size-hit)] w-full flex-1 resize-none rounded-control border border-border-strong bg-surface-panel px-3 py-2 font-sans text-sm text-text transition-shadow duration-(--duration-fast) placeholder:text-text-faint focus:outline-none focus-visible:shadow-focus"
      ></textarea>
      {#if menu.argumentHint}
        <!-- A textarea only shows its placeholder when empty, so the hint trails the inserted name. -->
        <div
          aria-hidden="true"
          data-argument-hint
          class="pointer-events-none absolute inset-0 overflow-hidden border border-transparent px-3 py-2 font-sans text-sm whitespace-pre"
        >
          <span class="invisible">{text}</span><span class="text-text-faint"
            >{menu.argumentHint}</span
          >
        </div>
      {/if}
    </div>
    <Button variant="primary" disabled={!canSend} busy={sending} onclick={() => void send()}
      >Send</Button
    >
  </div>
</div>
