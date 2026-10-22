<script lang="ts">
  import { activeSession } from '../../stores/active-session.svelte'
  import { groups } from '../../stores/groups.svelte'
  import { review } from '../../stores/review.svelte'
  import ReviewScreen from '../review/ReviewScreen.svelte'
  import { workerTerminals } from '../../stores/worker-terminals.svelte'
  import { workerControl } from '../../stores/worker-control.svelte'
  import { messageFor } from '../../ipc/messages'
  import Banner from '../ui/Banner.svelte'
  import Button from '../ui/Button.svelte'
  import AgentColumn from './AgentColumn.svelte'
  import ProviderNote from './ProviderNote.svelte'
  import ConversationTabs from './ConversationTabs.svelte'
  import EventLog from './EventLog.svelte'
  import SessionHeader from './SessionHeader.svelte'
  import WorkerDetails from './WorkerDetails.svelte'

  const header = $derived(activeSession.header)
  const detailsWorker = $derived(
    activeSession.workers.find((w) => w.id === workerTerminals.detailsId) ?? null
  )

  // Tabs and their buffers belong to one session.
  $effect(() => {
    void activeSession.sessionId
    return () => {
      workerTerminals.reset()
      workerControl.reset()
    }
  })

  // The review belongs to one session.
  $effect(() => {
    void activeSession.sessionId
    return () => review.reset()
  })

  const changedCount = $derived(
    review.open && review.loaded ? review.fileCount : activeSession.changedFileCount
  )

  const groupName = $derived(groups.list.find((g) => g.id === header?.groupId)?.name ?? '')
</script>

{#if header}
  <div
    class="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-3"
    data-session-screen
  >
    <div class="flex min-w-0 flex-col gap-3">
      <SessionHeader
        {header}
        {groupName}
        onback={() => activeSession.close()}
        {changedCount}
        onreview={() => void review.openReview(header.id)}
      />
      <ProviderNote {header} workers={activeSession.workers} />
    </div>
    <!-- Both bodies share one cell; the hidden one keeps its layout so scroll and drafts survive. -->
    <div class="grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)]">
      <div
        class="col-start-1 row-start-1 grid min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_minmax(300px,380px)] gap-3 {review.open
          ? 'pointer-events-none invisible'
          : ''}"
        inert={review.open}
        data-session-body
      >
        <div class="min-h-0 min-w-0">
          <ConversationTabs sessionId={header.id} workers={activeSession.workers} />
        </div>
        <div class="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_minmax(120px,32%)] gap-3">
          <AgentColumn
            brainState={activeSession.brainState}
            brainRunningOn={activeSession.header?.brainRunningOn}
            workers={activeSession.workers}
          />
          <EventLog events={activeSession.events} />
        </div>
      </div>
      {#if review.open}
        <div class="col-start-1 row-start-1 min-h-0 min-w-0">
          <ReviewScreen onback={() => review.close()} />
        </div>
      {/if}
    </div>
  </div>
  {#if detailsWorker}
    <WorkerDetails worker={detailsWorker} onclose={() => workerTerminals.closeDetails()} />
  {/if}
{:else if activeSession.loadError}
  <div class="flex flex-col gap-3 p-4">
    <Banner kind="error">{messageFor(activeSession.loadError)}</Banner>
    <div><Button onclick={() => activeSession.close()}>Back to sessions</Button></div>
  </div>
{:else}
  <p class="p-4 text-sm text-text-muted" role="status">Loading session</p>
{/if}
