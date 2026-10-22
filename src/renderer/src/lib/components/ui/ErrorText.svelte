<script lang="ts">
  import Icon from './Icon.svelte'

  interface Props {
    message: string
    /** Set when a control points at this line with aria-describedby. */
    id?: string
    class?: string
  }

  let { message, id, class: className = '' }: Props = $props()
</script>

<!-- Red text never stands alone: the error icon carries the same meaning (spec 002 section 2.9). -->
<p {id} role="alert" class="flex items-start gap-1.5 text-sm text-danger {className}">
  <Icon name="error" size={16} class="mt-0.5" /><span>{message}</span>
</p>
