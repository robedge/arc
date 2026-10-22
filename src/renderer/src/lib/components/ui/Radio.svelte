<script lang="ts">
  import ErrorText from './ErrorText.svelte'
  interface Props {
    id: string
    name: string
    label: string
    /** Secondary text under the label, linked with aria-describedby. */
    description?: string
    value: string
    group: string
    /** Shown below the radio and linked with aria-describedby. aria-invalid is not valid on a radio: put it on the radiogroup/fieldset that wraps the options. */
    error?: string | null
    disabled?: boolean
    onchange?: () => void
  }

  let {
    id,
    name,
    label,
    description,
    value,
    group = $bindable(),
    error = null,
    disabled = false,
    onchange
  }: Props = $props()
</script>

<div class="flex flex-col gap-1">
  <label
    for={id}
    class="inline-flex min-h-[var(--size-hit)] cursor-pointer items-start gap-3 py-2 text-sm text-text"
  >
    <input
      {id}
      {name}
      {value}
      type="radio"
      bind:group
      {disabled}
      {onchange}
      aria-describedby={[description ? `${id}-desc` : null, error ? `${id}-error` : null]
        .filter(Boolean)
        .join(' ') || undefined}
      class="size-5 shrink-0 cursor-pointer appearance-none rounded-full border border-border-strong bg-surface-code checked:border-accent checked:bg-[radial-gradient(circle,var(--color-accent)_0_38%,transparent_42%)] checked:shadow-glow-accent focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
    />
    <span>
      {label}
      {#if description}<span id="{id}-desc" class="block text-xs text-text-muted"
          >{description}</span
        >{/if}
    </span>
  </label>
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
