<script lang="ts">
  import { onMount } from 'svelte'
  import type { PluginKind, PluginRow as PluginRowData } from '@shared/types/plugins'
  import { providers } from '../../stores/providers.svelte'
  import { plugins, type PluginsStatus } from '../../stores/plugins.svelte'
  import CliBanner from '../sessions/CliBanner.svelte'
  import Button from '../ui/Button.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import InstallPluginForm from './InstallPluginForm.svelte'
  import PluginRow from './PluginRow.svelte'
  import RemovePluginDialog from './RemovePluginDialog.svelte'

  interface Props {
    /** Fixed content for the Design Preview, which must not touch the store or IPC. */
    preview?: {
      status: PluginsStatus
      rows: PluginRowData[]
      reason?: string | null
      /** A change in progress. */
      op?: { kind: PluginKind; target: string } | null
      /** The CLI's message from a failed change. */
      failure?: string | null
    }
  }

  let { preview }: Props = $props()

  const view = $derived(preview ?? plugins)
  const op = $derived(preview ? (preview.op ?? null) : plugins.op)
  const failure = $derived(preview ? (preview.failure ?? null) : plugins.failure)
  const unavailable = $derived(providers.claude !== undefined && providers.claude.state !== 'ok')
  const locked = $derived(unavailable || op !== null)

  let removing = $state<PluginRowData | null>(null)

  function displayName(target: string): string {
    return view.rows.find((r) => r.id === target)?.name ?? target.split('@')[0] ?? target
  }

  const otherStatus = $derived.by(() => {
    if (!op || op.kind === 'install') return ''
    if (op.kind === 'check-updates') return 'Checking for updates…'
    return `${op.kind === 'update' ? 'Updating' : 'Removing'} ${displayName(op.target)}…`
  })

  function rowBusy(id: string): 'update' | 'uninstall' | null {
    if (op?.target !== id) return null
    return op.kind === 'update' || op.kind === 'uninstall' ? op.kind : null
  }

  function confirmRemove(): void {
    const row = removing
    removing = null
    if (row && !preview) void plugins.uninstall(row.id)
  }

  onMount(() => {
    if (!preview) void plugins.load()
  })
</script>

<section aria-labelledby="plugins-title" class="flex flex-col gap-3">
  <div class="flex flex-col gap-1">
    <h2
      id="plugins-title"
      class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
    >
      Plugins
    </h2>
    <p class="text-sm text-text-muted">
      These are the same plugins Claude Code uses in the terminal, so changes here apply there too.
    </p>
    <p class="text-sm text-text-muted">Changes apply to agents started afterwards.</p>
  </div>
  <CliBanner />
  <InstallPluginForm
    disabled={locked}
    installing={preview ? (op?.kind === 'install' ? op.target : null) : undefined}
  />
  <div class="flex flex-wrap items-center gap-3">
    <Button
      busy={op?.kind === 'check-updates'}
      disabled={locked && op?.kind !== 'check-updates'}
      onclick={() => {
        if (!preview) void plugins.checkUpdates()
      }}>Check for updates</Button
    >
    <p class="text-sm text-text-muted" role="status" aria-live="polite" data-plugin-status>
      {otherStatus}
    </p>
  </div>
  {#if failure}
    <div class="flex flex-col gap-1">
      <ErrorText message="Claude Code couldn't finish that change." />
      <pre
        class="font-mono text-xs break-words whitespace-pre-wrap text-text-muted"
        data-plugin-failure>{failure}</pre>
    </div>
  {/if}
  {#if view.status === 'loading'}
    <p class="py-4 text-sm tracking-label text-text-muted" role="status">Loading plugins…</p>
  {:else if view.status === 'error'}
    <div class="flex flex-col gap-1">
      <ErrorText message="Couldn't load your plugins." />
      {#if view.reason}
        <pre
          class="font-mono text-xs break-words whitespace-pre-wrap text-text-muted"
          data-plugin-error>{view.reason}</pre>
      {/if}
    </div>
  {:else if view.rows.length === 0}
    <EmptyState text="No plugins installed" icon="folder" />
  {:else}
    <ul aria-label="Installed plugins" class="rounded-hud border border-border">
      {#each view.rows as plugin (plugin.id)}
        <PluginRow
          {plugin}
          busyKind={rowBusy(plugin.id)}
          disabled={locked}
          onupdate={(p) => {
            if (!preview) void plugins.update(p.id)
          }}
          onremove={(p) => (removing = p)}
        />
      {/each}
    </ul>
  {/if}
</section>

{#if removing}
  <RemovePluginDialog
    name={removing.name}
    onconfirm={confirmRemove}
    oncancel={() => (removing = null)}
  />
{/if}
