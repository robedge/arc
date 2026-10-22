<script lang="ts">
  import type { ModelRef } from '@shared/types/provider'
  import { decodeRef, encodeRef, modelGroups, readinessOf } from '../../model-options'
  import { models } from '../../stores/models.svelte'
  import { providers } from '../../stores/providers.svelte'
  import CursorEffort from '../ui/CursorEffort.svelte'
  import Select from '../ui/Select.svelte'

  interface Props {
    id: string
    value: ModelRef
    onchange: (ref: ModelRef) => void
  }

  let { id, value, onchange }: Props = $props()

  const ready = $derived(readinessOf(providers.statuses))
  // Same lists as the session header: Codex and Cursor only while they are ready; a current pick
  // whose provider is down stays, flagged "(unavailable)".
  const options = $derived(
    modelGroups({
      models: models.lists,
      ready,
      current: value,
      offerCodex: ready.codex === true,
      offerCursor: ready.cursor === true
    })
  )
</script>

<div class="flex flex-wrap items-end gap-3" data-brain-picker>
  <div class="min-w-48 flex-1">
    <Select
      {id}
      label="Brain"
      {options}
      bind:value={() => encodeRef(value), (v) => onchange(decodeRef(v))}
    />
  </div>
  {#if value.provider === 'cursor'}
    <CursorEffort
      {id}
      subject="the brain"
      models={models.lists.cursor}
      model={value.model}
      onchange={(model) => onchange({ provider: 'cursor', model })}
    />
  {/if}
</div>
