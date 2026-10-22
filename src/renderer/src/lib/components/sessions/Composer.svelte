<script lang="ts">
  import type { BrainState } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { activeSession } from '../../stores/active-session.svelte'
  import { commands } from '../../stores/commands.svelte'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import CliBanner from './CliBanner.svelte'
  import CommandMenu from './CommandMenu.svelte'
  import { commandOptionId } from './command-filter'
  import { SlashMenu } from './slash-menu.svelte'

  interface Props {
    sessionId: string
    brainState: BrainState
  }

  let { sessionId, brainState }: Props = $props()

  // Only a running turn is stoppable; while the brain waits on the user (a plan decision), sending
  // is the way to answer it.
  const thinking = $derived(brainState === 'thinking')

  // The parent keys this component by session, so the draft is read once.
  // svelte-ignore state_referenced_locally
  let text = $state(activeSession.draftFor(sessionId))
  let sending = $state(false)
  let error = $state<string | null>(null)

  const menuId = $derived(`command-menu-${sessionId}`)
  const menu = new SlashMenu({
    sessionId: () => sessionId,
    text: () => text,
    setText: (next) => {
      text = next
      activeSession.setDraft(sessionId, next)
    }
  })
  const catalogue = $derived(menu.catalogue)
  const menuOpen = $derived(menu.open)
  const matches = $derived(menu.matches)
  const hasOptions = $derived(menu.hasOptions)
  const argumentHint = $derived(menu.argumentHint)
  const activeIndex = $derived(menu.activeIndex)

  // Prefetch so the list is ready by the time the user types `/`.
  $effect(() => commands.ensure(sessionId))

  const canSend = $derived(text.trim().length > 0 && !sending)

  function oninput(): void {
    activeSession.setDraft(sessionId, text)
    error = null
    menu.oninput()
  }

  async function send(): Promise<void> {
    if (!canSend || thinking) return
    sending = true
    try {
      const failure = await activeSession.send(text.trimEnd())
      if (failure) {
        error = messageFor(failure)
        return
      }
      text = ''
      activeSession.setDraft(sessionId, '')
    } finally {
      sending = false
    }
  }

  function onkeydown(event: KeyboardEvent): void {
    if (menuOpen && menu.onKey(event)) return
    if (event.key !== 'Enter' || event.shiftKey) return
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    void send()
  }
</script>

<div class="flex min-w-0 shrink-0 flex-col gap-2 border-t border-border p-3" data-composer>
  <CliBanner />
  {#if error}<ErrorText message={error} />{/if}
  <div class="relative flex items-end gap-2">
    {#if menuOpen}
      <CommandMenu
        id={menuId}
        status={catalogue.status}
        commands={matches}
        {activeIndex}
        onpick={(command) => menu.pick(command)}
        onretry={() => void commands.load(sessionId)}
      />
    {/if}
    <label for="composer-input" class="sr-only">Message to the brain</label>
    <div class="relative flex min-w-0 flex-1">
      <textarea
        id="composer-input"
        bind:value={text}
        {oninput}
        {onkeydown}
        rows={2}
        role="combobox"
        aria-expanded={menuOpen}
        aria-controls={hasOptions ? menuId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={hasOptions ? commandOptionId(menuId, activeIndex) : undefined}
        placeholder="Message the brain"
        class="max-h-40 min-h-[var(--size-hit)] w-full flex-1 resize-none rounded-control border border-border-strong bg-surface-panel px-3 py-2 font-sans text-sm text-text transition-shadow duration-(--duration-fast) placeholder:text-text-faint focus:outline-none focus-visible:shadow-focus"
      ></textarea>
      {#if argumentHint}
        <!-- A textarea only shows its placeholder when empty, so the hint trails the inserted name. -->
        <div
          aria-hidden="true"
          data-argument-hint
          class="pointer-events-none absolute inset-0 overflow-hidden border border-transparent px-3 py-2 font-sans text-sm whitespace-pre"
        >
          <span class="invisible">{text}</span><span class="text-text-faint">{argumentHint}</span>
        </div>
      {/if}
    </div>
    {#if thinking}
      <Button variant="danger" onclick={() => void activeSession.stop()}>Stop</Button>
    {:else}
      <Button variant="primary" disabled={!canSend} busy={sending} onclick={() => void send()}
        >Send</Button
      >
    {/if}
  </div>
</div>
