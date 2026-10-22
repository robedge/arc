<script lang="ts">
  import Icon from './Icon.svelte'
  import type { IconName } from './icons'

  interface Props {
    /** The message, kept in one text node. */
    text: string
    icon?: IconName
    class?: string
  }

  let { text, icon = 'info', class: className = '' }: Props = $props()
</script>

<p
  data-empty-state
  class="flex items-center gap-2 py-4 text-sm tracking-label text-text-muted {className}"
>
  <Icon name={icon} size={16} class="text-line-faint" />
  <span>{text}</span>
</p>
