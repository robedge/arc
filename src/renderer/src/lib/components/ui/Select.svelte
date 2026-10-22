<script lang="ts">
  import ErrorText from './ErrorText.svelte'
  import { isGroup, type PickerEntry } from '../../model-options'

  interface Props {
    id: string
    label: string
    value: string
    /** Options, or labelled groups of options (rendered as `optgroup`). */
    options: readonly PickerEntry[]
    error?: string | null
    disabled?: boolean
    onchange?: () => void
    /** Id of an element that describes the select (e.g. why it is disabled). */
    describedby?: string
  }

  let {
    id,
    label,
    value = $bindable(),
    options,
    error = null,
    disabled = false,
    onchange,
    describedby
  }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label for={id} class="text-sm font-medium text-text">{label}</label>
  <select
    {id}
    bind:value
    {disabled}
    {onchange}
    aria-invalid={error ? 'true' : 'false'}
    aria-describedby={[describedby, error ? `${id}-error` : undefined].filter(Boolean).join(' ') ||
      undefined}
    class="min-h-[var(--size-hit)] w-full rounded-control border bg-surface-panel px-3 py-2 font-sans text-sm text-text transition-shadow duration-(--duration-fast) focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 {error
      ? 'border-danger'
      : 'border-border-strong'}"
  >
    {#each options as entry (isGroup(entry) ? `group:${entry.group}` : entry.value)}
      {#if isGroup(entry)}
        <optgroup label={entry.group}>
          {#each entry.options as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </optgroup>
      {:else}
        <option value={entry.value}>{entry.label}</option>
      {/if}
    {/each}
  </select>
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
