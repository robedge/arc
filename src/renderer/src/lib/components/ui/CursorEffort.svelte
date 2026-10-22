<script lang="ts">
  import type { ModelInfo } from '@shared/types/provider'
  import { cursorEffort, resolveCursorEffort } from '../../model-options'

  interface Props {
    /** Cursor's models; the control resolves the picked model's effort and fast switch to one of them. */
    models: readonly ModelInfo[]
    /** The picked model id. */
    model: string
    /** Id prefix for the controls. */
    id: string
    /** Names what the control is for, e.g. a worker: "Cursor effort for api-retry". */
    subject?: string
    disabled?: boolean
    /** Called with the full model id after a change. */
    onchange: (model: string) => void
  }

  let { models, model, id, subject, disabled = false, onchange }: Props = $props()

  const choice = $derived(cursorEffort(models, model))
  const name = $derived(`Cursor effort${subject ? ` for ${subject}` : ''}`)
</script>

{#if choice}
  <div class="flex items-center gap-2" data-cursor-effort>
    <label for="{id}-effort" class="text-xs tracking-label text-text-muted uppercase">Effort</label>
    <select
      id="{id}-effort"
      aria-label={name}
      {disabled}
      value={choice.effort}
      onchange={(e) =>
        onchange(resolveCursorEffort(models, model, { effort: e.currentTarget.value }))}
      class="min-h-[var(--size-hit)] rounded-control border border-border-strong bg-surface-panel px-2 font-sans text-sm text-text focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
    >
      {#each choice.levels as level (level.value)}
        <option value={level.value}>{level.label}</option>
      {/each}
    </select>
    {#if choice.fastOffered}
      <label class="flex items-center gap-1 text-xs tracking-label text-text-muted uppercase">
        <input
          type="checkbox"
          {disabled}
          checked={choice.fast}
          aria-label="{name}: Fast"
          onchange={(e) =>
            onchange(resolveCursorEffort(models, model, { fast: e.currentTarget.checked }))}
        />
        Fast
      </label>
    {/if}
  </div>
{/if}
