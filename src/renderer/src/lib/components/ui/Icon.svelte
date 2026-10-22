<script lang="ts">
  import { icons, type IconName } from './icons'

  interface Props {
    name: IconName
    /** Makes the icon meaningful: it gets role="img" and this accessible name. */
    title?: string
    size?: number
    class?: string
  }

  let { name, title, size = 20, class: className = '' }: Props = $props()
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="0 0 24 24"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  class="shrink-0 {className}"
  data-icon={name}
  role={title ? 'img' : undefined}
  aria-label={title}
  aria-hidden={title ? undefined : 'true'}
>
  {#each icons[name] as d (d)}
    <path {d} />
  {/each}
</svg>
