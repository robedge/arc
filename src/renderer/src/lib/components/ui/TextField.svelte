<script lang="ts">
  import ErrorText from './ErrorText.svelte'

  interface Props {
    id: string
    label: string
    value: string
    error?: string | null
    oninput?: () => void
    maxlength?: number
    disabled?: boolean
    placeholder?: string
    /** Keeps the label for assistive tech but hides it visually. */
    hideLabel?: boolean
    onblur?: () => void
    onkeydown?: (event: KeyboardEvent) => void
  }

  let {
    id,
    label,
    value = $bindable(),
    error = null,
    oninput,
    maxlength,
    disabled = false,
    placeholder,
    hideLabel = false,
    onblur,
    onkeydown
  }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label for={id} class="text-sm font-medium text-text {hideLabel ? 'sr-only' : ''}">{label}</label>
  <input
    {id}
    type="text"
    bind:value
    {oninput}
    {maxlength}
    {disabled}
    {placeholder}
    {onblur}
    {onkeydown}
    autocomplete="off"
    aria-invalid={error ? 'true' : 'false'}
    aria-describedby={error ? `${id}-error` : undefined}
    class="min-h-[var(--size-hit)] w-full rounded-control border bg-surface-panel px-3 py-2 font-sans text-sm text-text transition-shadow duration-(--duration-fast) placeholder:text-text-faint focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 {error
      ? 'border-danger'
      : 'border-border-strong'}"
  />
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
