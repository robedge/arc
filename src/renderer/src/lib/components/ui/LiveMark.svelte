<script lang="ts">
  import { motion } from '../../stores/motion.svelte'

  interface Props {
    /** Spoken and tooltip text; the dot itself is decoration. */
    label?: string
    class?: string
  }

  let { label = 'still counting', class: klass = '' }: Props = $props()
</script>

<!-- A small accent dot that eases in and out while a number is still rising. -->
<span
  class="live-mark inline-flex shrink-0 items-center align-middle {klass}"
  title={label}
  data-pulse={motion.reduced ? undefined : 'true'}
  data-in-progress
>
  <span aria-hidden="true" class="live-dot size-1.5 rounded-pill bg-accent"></span>
  <span class="sr-only">{label}</span>
</span>

<style>
  .live-dot {
    box-shadow: var(--shadow-glow-accent);
  }
  .live-mark[data-pulse='true'] .live-dot {
    animation: live-pulse var(--duration-pulse) ease-in-out infinite;
  }
  :global(:root[data-motion='reduced']) .live-dot {
    animation: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .live-dot {
      animation: none;
    }
  }
  /* Opacity eases between 0.45 and 1; never an on/off flash. */
  @keyframes live-pulse {
    0%,
    100% {
      opacity: 0.45;
    }
    50% {
      opacity: 1;
    }
  }
</style>
