<script lang="ts">
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import Icon from './Icon.svelte'
  import type { IconName } from './icons'
  import { buttonVariants, type ButtonVariant } from './kinds'

  interface Props extends Omit<
    HTMLButtonAttributes,
    'class' | 'onclick' | 'type' | 'disabled' | 'title'
  > {
    /** Required: becomes the accessible name. */
    label: string
    icon: IconName
    variant?: ButtonVariant
    type?: 'button' | 'submit'
    disabled?: boolean
    busy?: boolean
    /** Fits inside a bar shorter than the touch-target size (the title bar). */
    compact?: boolean
    onclick?: (event: MouseEvent) => void
  }

  let {
    label,
    icon,
    variant = 'secondary',
    type = 'button',
    disabled = false,
    busy = false,
    compact = false,
    onclick,
    ...rest
  }: Props = $props()

  const style = $derived(buttonVariants[variant])

  function handleClick(event: MouseEvent): void {
    if (busy || disabled) {
      event.preventDefault()
      return
    }
    onclick?.(event)
  }
</script>

<button
  {...rest}
  {type}
  {disabled}
  onclick={handleClick}
  aria-label={label}
  title={label}
  aria-busy={busy ? 'true' : undefined}
  data-variant={variant}
  class="inline-flex {compact
    ? 'size-8'
    : 'size-hit'} items-center justify-center rounded-control border transition-shadow duration-(--duration-fast) focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 {style.base} {style.hover}"
>
  <Icon name={icon} />
</button>
