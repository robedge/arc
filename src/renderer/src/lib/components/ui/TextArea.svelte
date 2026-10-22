<script lang="ts">
  import ErrorText from './ErrorText.svelte'
  interface Props {
    id: string
    label: string
    value: string
    error?: string | null
    oninput?: () => void
    maxlength?: number
    rows?: number
    disabled?: boolean
    readonly?: boolean
    hideLabel?: boolean
  }

  let {
    rows = 4,
    id,
    label,
    value = $bindable(),
    error = null,
    oninput,
    maxlength,
    disabled = false,
    readonly = false,
    hideLabel = false
  }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label for={id} class="text-sm font-medium text-text {hideLabel ? 'sr-only' : ''}">{label}</label>
  <textarea
    {id}
    bind:value
    {oninput}
    {maxlength}
    {rows}
    {disabled}
    {readonly}
    aria-invalid={error ? 'true' : 'false'}
    aria-describedby={error ? `${id}-error` : undefined}
    class="min-h-[var(--size-hit)] w-full resize-y rounded-control border bg-surface-panel px-3 py-2 font-sans text-sm text-text transition-shadow duration-(--duration-fast) placeholder:text-text-faint focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 {error
      ? 'border-danger'
      : 'border-border-strong'}"></textarea>
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
