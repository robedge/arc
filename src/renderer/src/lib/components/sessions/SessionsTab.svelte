<script lang="ts">
  import type { AppError } from '@shared/errors'
  import type { SessionSummary } from '@shared/types/session'
  import { messageFor } from '../../ipc/messages'
  import { activeSession } from '../../stores/active-session.svelte'
  import { sessionsList } from '../../stores/sessions-list.svelte'
  import { ui } from '../../stores/ui.svelte'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Panel from '../ui/Panel.svelte'
  import NameDialog from '../dialogs/NameDialog.svelte'
  import CliBanner from './CliBanner.svelte'
  import DirtyTreeDialog from './DirtyTreeDialog.svelte'
  import DeleteSessionDialog from './DeleteSessionDialog.svelte'
  import NewSessionDialog from './NewSessionDialog.svelte'
  import SessionRow from './SessionRow.svelte'
  import SessionScreen from './SessionScreen.svelte'

  interface Props {
    showBanner?: boolean
  }

  let { showBanner = true }: Props = $props()

  let creating = $state(false)
  let renaming = $state<SessionSummary | null>(null)
  let deleting = $state<SessionSummary | null>(null)
  const groupId = $derived(ui.selectedGroupId)
  const sessions = $derived(sessionsList.for(groupId))

  $effect(() => {
    if (groupId !== null) void sessionsList.load(groupId)
  })

  // An open session belongs to one group; switching groups returns to the list.
  $effect(() => {
    const open = activeSession.header
    if (open && open.groupId !== groupId) activeSession.close()
  })

  function sessionById(id: string): SessionSummary | null {
    return sessions.find((s) => s.id === id) ?? null
  }

  function validateName(raw: string): string | null {
    return raw.trim() === '' ? 'Enter a session name.' : null
  }

  async function renameTo(name: string): Promise<AppError | null> {
    const target = renaming
    if (!target) return null
    const res = await window.harness.invoke('sessions:rename', {
      sessionId: target.id,
      name: name.trim()
    })
    if (!res.ok) return res.error
    sessionsList.upsert(res.data)
    if (activeSession.sessionId === target.id) activeSession.setName(res.data.name)
    return null
  }

  function oncreated(sessionId: string): void {
    creating = false
    if (groupId !== null) void sessionsList.load(groupId)
    void activeSession.open(sessionId)
  }
</script>

{#if activeSession.sessionId !== null}
  <SessionScreen />
{:else}
  <Panel scroll role="tabpanel" aria-label="Sessions" class="h-full">
    <div class="flex flex-col gap-3 p-4">
      {#if showBanner}<CliBanner />{/if}
      <div class="flex items-center justify-between gap-3">
        {#if sessions.length === 0}
          <EmptyState
            class="py-0"
            icon="info"
            text="No sessions yet. Start one to ask the brain about this group."
          />
        {:else}
          <span></span>
        {/if}
        <Button variant="primary" disabled={groupId === null} onclick={() => (creating = true)}
          >New Session</Button
        >
      </div>
      {#if sessions.length > 0}
        <ul class="flex flex-col gap-2">
          {#each sessions as session (session.id)}
            <li>
              <SessionRow
                {session}
                onopen={(id) => void activeSession.open(id)}
                onrename={(id) => (renaming = sessionById(id))}
                ondelete={(id) => (deleting = sessionById(id))}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Panel>
{/if}

{#if activeSession.dirtyChoice}
  <DirtyTreeDialog
    token={activeSession.dirtyChoice.token}
    repos={activeSession.dirtyChoice.repos}
    {...activeSession.dirtyChoice.message ? { message: activeSession.dirtyChoice.message } : {}}
    onresolved={(result) => activeSession.resolveDirty(result)}
  />
{/if}

{#if creating && groupId !== null}
  <NewSessionDialog {groupId} onclose={() => (creating = false)} {oncreated} />
{/if}

{#if renaming}
  <NameDialog
    title="Rename Session"
    label="Session name"
    confirmText="Rename"
    initialValue={renaming.name}
    validate={validateName}
    submit={renameTo}
    formatError={messageFor}
    onclose={() => (renaming = null)}
  />
{/if}

{#if deleting}
  <DeleteSessionDialog session={deleting} onclose={() => (deleting = null)} />
{/if}
