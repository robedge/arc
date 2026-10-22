<script lang="ts">
  import { onMount } from 'svelte'
  import { groupDetail } from './lib/stores/group-detail.svelte'
  import { registerCloseFlush } from './lib/close-flush'
  import { knowledge } from './lib/stores/knowledge.svelte'
  import { storage } from './lib/stores/storage.svelte'
  import { models } from './lib/stores/models.svelte'
  import { providers } from './lib/stores/providers.svelte'
  import { usage } from './lib/stores/usage.svelte'
  import { planUsage } from './lib/stores/plan-usage.svelte'
  import { settings } from './lib/stores/settings.svelte'
  import { commands } from './lib/stores/commands.svelte'
  import { groups } from './lib/stores/groups.svelte'
  import { plugins } from './lib/stores/plugins.svelte'
  import { activeSession } from './lib/stores/active-session.svelte'
  import { review } from './lib/stores/review.svelte'
  import { workerTerminals } from './lib/stores/worker-terminals.svelte'
  import { sessionsList } from './lib/stores/sessions-list.svelte'
  import { navigateToAttention } from './lib/navigate-attention'
  import GroupSidebar from './lib/components/shell/GroupSidebar.svelte'
  import GroupView from './lib/components/shell/GroupView.svelte'
  import DialogHost from './lib/components/dialogs/DialogHost.svelte'
  import SettingsView from './lib/components/settings/SettingsView.svelte'
  import UsageView from './lib/components/usage/UsageView.svelte'
  import PlanNotices from './lib/components/banners/PlanNotices.svelte'
  import UpdateNotices from './lib/components/banners/UpdateNotices.svelte'
  import RestartPrompt from './lib/components/banners/RestartPrompt.svelte'
  import TitleBar from './lib/components/ui/TitleBar.svelte'
  import Toaster from './lib/components/ui/Toaster.svelte'
  import { ui } from './lib/stores/ui.svelte'
  import { motion } from './lib/stores/motion.svelte'

  // A DropZone stops propagation of handled events; anything reaching the window is
  // unhandled, so cancel it to stop the shell from navigating to a dropped file.
  function guardDrag(event: DragEvent): void {
    event.preventDefault()
  }

  onMount(() => {
    void groups.load()
    void models.load()
    void sessionsList.loadAttention()
    void planUsage.load()
  })

  $effect(() => registerCloseFlush())
  $effect(() => motion.start())

  $effect(() =>
    window.harness.on('availability:changed', (e) => {
      groupDetail.applyAvailability(e)
      storage.applyAvailability(e)
    })
  )
  $effect(() =>
    window.harness.on('providers:changed', (e) => {
      providers.set(e)
      void models.load()
    })
  )
  $effect(() => {
    const id = activeSession.sessionId
    if (id) void usage.loadSession(id)
  })
  $effect(() => window.harness.on('usage:session-changed', (e) => usage.applySession(e)))
  $effect(() => window.harness.on('usage:changed', () => usage.handleChanged()))
  $effect(() => window.harness.on('plan:changed', (e) => planUsage.apply(e)))
  $effect(() => window.harness.on('settings:changed', (e) => settings.apply(e)))
  $effect(() => window.harness.on('commands:changed', () => commands.handleChanged()))
  $effect(() => window.harness.on('plugins:progress', (e) => plugins.handleProgress(e)))
  $effect(() => window.harness.on('plugins:changed', () => void plugins.load(true)))
  $effect(() => window.harness.on('session:brain-delta', (e) => activeSession.applyDelta(e)))
  $effect(() =>
    window.harness.on('session:message', (e) => {
      sessionsList.touch(e.sessionId, e.message.updatedAt)
      activeSession.applyMessage(e)
    })
  )
  $effect(() =>
    window.harness.on('session:event-logged', (e) => {
      activeSession.applyEvents(e)
    })
  )
  $effect(() => window.harness.on('session:summary', (e) => sessionsList.applySummary(e)))
  $effect(() => window.harness.on('session:brain-state', (e) => activeSession.applyBrainState(e)))
  $effect(() => window.harness.on('session:header', (e) => activeSession.applyHeader(e)))
  $effect(() =>
    window.harness.on('session:dirty-question', (e) => activeSession.applyDirtyQuestion(e))
  )
  $effect(() => window.harness.on('session:plan', (e) => activeSession.applyPlan(e)))
  $effect(() => window.harness.on('session:worker-changed', (e) => activeSession.applyWorker(e)))
  $effect(() =>
    window.harness.on('session:review-changed', (e) => {
      if (activeSession.applyReviewChanged(e)) review.queueRefresh(e)
    })
  )
  $effect(() => window.harness.on('worker:terminal', (e) => workerTerminals.apply(e)))
  $effect(() =>
    window.harness.on('session:attention', (e) => {
      sessionsList.applyAttention(e)
      activeSession.applyAttention(e)
    })
  )
  $effect(() => window.harness.on('session:open-attention', (e) => void navigateToAttention(e)))
  $effect(() => window.harness.on('storage:progress', (e) => storage.handleProgress(e)))
  $effect(() => window.harness.on('knowledge:changed', (e) => knowledge.handleChanged(e)))
</script>

<svelte:window ondragover={guardDrag} ondrop={guardDrag} onfocus={() => void planUsage.refresh()} />

<div class="flex h-full min-h-0 flex-col text-text">
  <TitleBar />
  <UpdateNotices />
  <PlanNotices />
  {#if ui.view === 'settings'}
    <SettingsView />
  {:else if ui.view === 'usage'}
    <UsageView />
  {:else}
    <main class="grid min-h-0 flex-1 grid-cols-[var(--size-sidebar)_minmax(0,1fr)] gap-3 p-3">
      <GroupSidebar />
      <GroupView />
    </main>
  {/if}
</div>
<DialogHost />
<RestartPrompt />
<Toaster />
