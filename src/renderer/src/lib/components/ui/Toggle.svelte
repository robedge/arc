<script lang="ts">
  import ErrorText from './ErrorText.svelte'
  interface Props {
    id: string
    label: string
    checked: boolean
    error?: string | null
    disabled?: boolean
    /** Keep the label for assistive technology only (a grid of switches names each one without repeating text). */
    labelHidden?: boolean
    onchange?: () => void
  }

  let {
    id,
    label,
    checked = $bindable(),
    error = null,
    disabled = false,
    labelHidden = false,
    onchange
  }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label
    for={id}
    class="inline-flex min-h-[var(--size-hit)] cursor-pointer items-center gap-3 text-sm text-text"
  >
    <input
      {id}
      type="checkbox"
      role="switch"
      bind:checked
      {disabled}
      {onchange}
      aria-invalid={error ? 'true' : 'false'}
      aria-describedby={error ? `${id}-error` : undefined}
      class="relative h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-pill border border-border-strong bg-surface-raised transition-colors duration-(--duration-fast) before:absolute before:top-0.5 before:left-0.5 before:size-4 before:rounded-pill before:bg-text-muted before:transition-transform before:duration-(--duration-fast) before:content-[''] checked:border-accent checked:bg-accent/30 checked:before:translate-x-5 checked:before:bg-accent focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
    />
    <span class={labelHidden ? 'sr-only' : ''}>{label}</span>
  </label>
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
