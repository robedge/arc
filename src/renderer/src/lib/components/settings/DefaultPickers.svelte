<script lang="ts">
  import type {
    AppSettings,
    ProviderModels,
    ProviderStatusMap,
    WorkersPref
  } from '@shared/types/provider'
  import {
    decodeRef,
    decodeWorkers,
    encodeRef,
    encodeWorkers,
    modelGroups,
    readinessOf,
    workersEntries
  } from '../../model-options'
  import CursorEffort from '../ui/CursorEffort.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import Select from '../ui/Select.svelte'

  interface Props {
    settings: AppSettings | null
    models: ProviderModels
    statuses: ProviderStatusMap
    error?: string | null
    onsave: (patch: Partial<AppSettings>) => void
  }

  let { settings, models, statuses, error = null, onsave }: Props = $props()

  const ready = $derived(readinessOf(statuses))
  const brain = $derived(settings?.['providers.brain'])
  const workers = $derived<WorkersPref>(settings?.['providers.workers'] ?? { mode: 'auto' })

  // Settings may keep a Codex brain default, so both groups are offered. A saved Codex or Cursor
  // pick stays in the list, flagged "(unavailable)", while its provider is not ready.
  const brainOptions = $derived(
    modelGroups({
      models,
      ready,
      current: brain ?? null,
      offerCodex: true,
      offerCursor: ready.cursor === true
    })
  )
  const workerOptions = $derived(workersEntries(models, ready, workers))
</script>

<div class="flex flex-col gap-3" data-default-pickers>
  <h3 class="font-display text-base font-semibold text-text-bright">Defaults for new sessions</h3>
  <p class="text-sm text-text-muted">
    New sessions start with these. Sessions already open keep their own choices.
  </p>
  {#if brain}
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-48 flex-1">
        <Select
          id="default-brain"
          label="Default brain"
          options={brainOptions}
          bind:value={() => encodeRef(brain), (v) => onsave({ 'providers.brain': decodeRef(v) })}
        />
      </div>
      {#if brain.provider === 'cursor'}
        <CursorEffort
          id="default-brain"
          models={models.cursor}
          model={brain.model}
          onchange={(model) => onsave({ 'providers.brain': { provider: 'cursor', model } })}
        />
      {/if}
    </div>
  {/if}
  <div class="flex flex-wrap items-end gap-3">
    <div class="min-w-48 flex-1">
      <Select
        id="default-workers"
        label="Default workers"
        options={workerOptions}
        bind:value={
          () => encodeWorkers(workers), (v) => onsave({ 'providers.workers': decodeWorkers(v) })
        }
      />
    </div>
    {#if workers.mode === 'model' && workers.model.provider === 'cursor'}
      <CursorEffort
        id="default-workers"
        models={models.cursor}
        model={workers.model.model}
        onchange={(model) =>
          onsave({ 'providers.workers': { mode: 'model', model: { provider: 'cursor', model } } })}
      />
    {/if}
  </div>
  {#if error}<ErrorText message={error} />{/if}
</div>
