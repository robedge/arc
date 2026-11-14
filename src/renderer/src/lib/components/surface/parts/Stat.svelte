<script lang="ts">
  interface Props {
    label: string
    value: string
    delta: string
    note: string
    /** The arrow shown before the delta. */
    arrow: string
    /** Tailwind text classes for the delta. */
    deltaClass: string
  }

  let { label, value, delta, note, arrow, deltaClass }: Props = $props()
</script>

<div
  data-stat
  class="flex min-w-0 flex-col gap-1 rounded-hud border border-border bg-surface-panel p-3"
>
  <span class="text-xs tracking-label text-text-muted uppercase">{label}</span>
  <span class="text-2xl font-semibold text-text-bright">{value}</span>
  {#if delta}
    <span class="text-xs font-medium {deltaClass}">{arrow} {delta}</span>
  {/if}
  {#if note}<span class="text-xs text-text-muted">{note}</span>{/if}
</div>
