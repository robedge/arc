<script lang="ts">
  import { onMount } from 'svelte'
  import {
    type AppSettings,
    type BypassReport,
    type ProviderId,
    type ProviderModels,
    type ProviderStatusMap
  } from '@shared/types/provider'
  import { providerIds } from '@shared/provider-label'
  import { models } from '../../stores/models.svelte'
  import { providers } from '../../stores/providers.svelte'
  import { settings } from '../../stores/settings.svelte'
  import Toggle from '../ui/Toggle.svelte'
  import BypassWarning from './BypassWarning.svelte'
  import DefaultPickers from './DefaultPickers.svelte'
  import ProviderStatusRow from './ProviderStatusRow.svelte'

  interface Props {
    /** Fixed statuses for the Design Preview, which must not touch the store or IPC. */
    preview?: ProviderStatusMap
    /** Fixed defaults and model lists for the Design Preview. */
    previewDefaults?: { settings: AppSettings; models: ProviderModels }
    /** A fixed bypass report for the Design Preview. */
    previewBypass?: BypassReport
  }

  let { preview, previewDefaults, previewBypass }: Props = $props()

  const statuses = $derived(preview ?? providers.statuses)

  function check(provider: ProviderId): void {
    if (!preview) void providers.check(provider)
  }

  let launchCheck = $derived(
    (previewDefaults ? previewDefaults.settings : settings.values)?.[
      'usage.checkClaudePlanOnLaunch'
    ] ?? true
  )

  onMount(() => {
    if (!preview) {
      void providers.load()
      void models.load()
      void settings.load()
      void providers.loadBypass()
    }
  })
</script>

<section aria-labelledby="providers-title" class="flex flex-col gap-3">
  <div class="flex flex-col gap-1">
    <h2
      id="providers-title"
      class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
    >
      Providers
    </h2>
    <p class="text-sm text-text-muted">
      Arc uses the Claude, Codex and Cursor tools already on this Mac and never handles your
      sign-in.
    </p>
  </div>
  <ul class="flex flex-col gap-2" aria-label="Provider status">
    {#each providerIds as id (id)}
      <ProviderStatusRow
        provider={id}
        status={statuses[id]}
        busy={preview ? false : providers.busy[id]}
        oncheck={() => check(id)}
      />
    {/each}
  </ul>
  <DefaultPickers
    settings={previewDefaults ? previewDefaults.settings : settings.values}
    models={previewDefaults ? previewDefaults.models : models.lists}
    statuses={preview ?? providers.statuses}
    error={preview ? null : settings.error}
    onsave={(patch) => {
      if (!preview) void settings.save(patch)
    }}
  />
  <BypassWarning
    report={previewBypass ?? (preview ? null : providers.bypass)}
    busy={preview ? false : providers.bypassBusy}
    onrefresh={() => {
      if (!preview) void providers.loadBypass()
    }}
  />
  <div class="flex flex-col gap-1">
    <Toggle
      id="check-claude-plan"
      label="Check Claude plan usage when Arc opens"
      bind:checked={launchCheck}
      onchange={() => {
        if (!preview) void settings.save({ 'usage.checkClaudePlanOnLaunch': launchCheck })
      }}
    />
    <p class="text-xs text-text-muted">
      Sends one very small request using the lightest Claude model each time Arc opens. It uses a
      tiny amount of your plan.
    </p>
  </div>
</section>
