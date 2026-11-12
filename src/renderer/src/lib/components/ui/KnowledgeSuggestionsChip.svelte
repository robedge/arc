<script lang="ts">
  interface Props {
    count: number
    onclick: () => void
  }

  let { count, onclick }: Props = $props()
</script>

{#if count > 0}
  <button
    type="button"
    {onclick}
    aria-label="Knowledge suggestions, {count} waiting"
    aria-haspopup="dialog"
    data-knowledge-suggestions-chip
    class="inline-flex min-h-[var(--size-hit)] items-center gap-2 rounded-control border border-accent/45 bg-accent/10 px-3 font-sans text-sm font-semibold tracking-label text-accent uppercase focus:outline-none focus-visible:shadow-focus"
  >
    <span aria-hidden="true">Suggestions</span>
    <span
      aria-hidden="true"
      class="min-w-6 rounded-full bg-accent px-2 text-center text-xs text-accent-ink"
      data-count>{count}</span
    >
  </button>
{/if}
