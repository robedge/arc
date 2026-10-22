<script lang="ts">
  import { motion } from '../../stores/motion.svelte'

  let { size = 28, spinning = true }: { size?: number; spinning?: boolean } = $props()
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 32 32"
  width={size}
  height={size}
  fill="none"
  aria-hidden="true"
  class="ring-logo text-accent"
  data-spin={motion.reduced || !spinning ? undefined : 'true'}
>
  <circle cx="16" cy="16" r="13" stroke="currentColor" stroke-width="2" stroke-dasharray="52 12" />
  <circle cx="16" cy="16" r="6" stroke="currentColor" stroke-width="1.5" opacity="0.6" />
  <circle cx="16" cy="16" r="1.75" fill="currentColor" />
</svg>

<style>
  .ring-logo[data-spin] {
    animation: ring-spin var(--duration-idle-spin) linear infinite;
  }
  @keyframes ring-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
