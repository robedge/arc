<script lang="ts">
  import { groups } from '../../stores/groups.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { groupDetail } from '../../stores/group-detail.svelte'
  import { SECTION_SESSIONS, ui } from '../../stores/ui.svelte'
  import { storage } from '../../stores/storage.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import Panel from '../ui/Panel.svelte'
  import KnowledgeStorageSettings from '../settings/KnowledgeStorageSettings.svelte'
  import StorageMissingBanner from '../banners/StorageMissingBanner.svelte'
  import SectionNav from './SectionNav.svelte'
  import SessionsTab from '../sessions/SessionsTab.svelte'
  import SectionPane from './SectionPane.svelte'

  let group = $derived(groups.list.find((g) => g.id === ui.selectedGroupId) ?? null)
  $effect(() => {
    void storage.load(ui.selectedGroupId)
  })
  // Projects don't live in the knowledge folder, so that pane stays usable while it is missing.
  let section = $derived(
    storage.missing
      ? (groupDetail.sections.find((s) => s.kind === 'projects') ?? null)
      : (groupDetail.sections.find((s) => s.id === ui.activeSectionId) ?? null)
  )
  let showSessions = $derived(!storage.missing && ui.activeSectionId === SECTION_SESSIONS)
  // While a session is open its header names the group, so the static header content collapses.
  // Banners never collapse.
  let collapsed = $derived(showSessions && activeSession.sessionId !== null)
</script>

<section class="flex min-h-0 min-w-0 flex-col gap-3">
  {#if group}
    {#if !collapsed || storage.missing}
      <Panel as="div" class="shrink-0">
        <div class="flex flex-col gap-2 px-4 py-3">
          {#if !collapsed}
            <h2
              class="font-display text-[22px] font-bold tracking-title break-words text-text-bright uppercase"
            >
              {group.name}
            </h2>
            <KnowledgeStorageSettings groupId={group.id} />
          {/if}
          {#if storage.missing}
            <StorageMissingBanner
              linkedPath={storage.state?.linkedPath ?? null}
              busy={storage.busy}
              error={storage.error}
              onlocate={() => void storage.locate()}
              onuseapp={() => {
                storage.error = null
                ui.openDialog({ kind: 'storage-use-app' })
              }}
            />
          {/if}
        </div>
      </Panel>
    {/if}
    <div class="shrink-0">
      <SectionNav
        disabled={storage.missing}
        activeId={showSessions ? SECTION_SESSIONS : (section?.id ?? null)}
      />
    </div>
    {#if showSessions}
      <div class="min-h-0 flex-1">
        <SessionsTab />
      </div>
    {:else if section}
      <div class="min-h-0 flex-1">
        <SectionPane {section} />
      </div>
    {/if}
  {:else}
    <Panel class="shrink-0">
      <EmptyState class="px-4" icon="folder" text="Create a group to get started." />
    </Panel>
  {/if}
</section>
