<script lang="ts">
  import { motion } from '../../stores/motion.svelte'

  interface Props {
    count: number
    onclick: () => void
  }

  let { count, onclick }: Props = $props()
</script>

<button
  type="button"
  {onclick}
  aria-label="Needs attention, {count} waiting"
  data-pulse={motion.reduced ? undefined : 'true'}
  class="attention-badge relative inline-flex min-h-[var(--size-hit)] items-center gap-2 rounded-control border border-attention bg-attention/10 px-3 font-sans text-sm font-semibold tracking-label text-attention-text uppercase focus:outline-none focus-visible:shadow-focus"
>
  <span aria-hidden="true">Needs attention</span>
  <span
    aria-hidden="true"
    class="min-w-6 rounded-full bg-attention px-2 text-center text-xs text-attention-ink"
    data-count>{count}</span
  >
</button>

<style>
  .attention-badge {
    box-shadow: var(--shadow-glow-attention);
  }
  .attention-badge[data-pulse='true'] {
    animation: badge-pulse var(--duration-pulse) ease-in-out infinite;
  }
  :global(:root[data-motion='reduced']) .attention-badge {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .attention-badge {
      animation: none;
    }
  }
  /* Glow intensity eases between 0.55 and 1.0; never an on/off flash. */
  @keyframes badge-pulse {
    0%,
    100% {
      box-shadow: 0 0 12px rgba(255, 183, 77, 0.22);
    }
    50% {
      box-shadow: 0 0 14px rgba(255, 183, 77, 0.4);
    }
  }
</style>
