<script lang="ts">
  import ErrorText from './ErrorText.svelte'
  interface Props {
    id: string
    label: string
    checked: boolean
    error?: string | null
    disabled?: boolean
    /** Keep the label for assistive technology only (a checkbox inside a list row). */
    hideLabel?: boolean
    onchange?: () => void
  }

  let {
    id,
    label,
    checked = $bindable(),
    error = null,
    disabled = false,
    hideLabel = false,
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
      bind:checked
      {disabled}
      {onchange}
      aria-invalid={error ? 'true' : 'false'}
      aria-describedby={error ? `${id}-error` : undefined}
      class="checked:bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 20 20%22><path d=%22M5 10.5l3.5 3.5L15 7%22 fill=%22none%22 stroke=%22%23020609%22 stroke-width=%222.2%22/></svg>')] size-5 shrink-0 cursor-pointer appearance-none rounded-hud border border-border-strong bg-surface-code bg-center bg-no-repeat checked:border-accent checked:bg-accent focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50"
    />
    <span class={hideLabel ? 'sr-only' : ''}>{label}</span>
  </label>
  {#if error}
    <ErrorText id="{id}-error" message={error} />
  {/if}
</div>
