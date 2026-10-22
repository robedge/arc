<script lang="ts">
  import type { Snippet } from 'svelte'
  import { buttonVariants, type ButtonVariant } from './kinds'

  interface Props {
    variant?: ButtonVariant
    type?: 'button' | 'submit'
    size?: 'md' | 'icon'
    disabled?: boolean
    /** Looks disabled and blocks clicks but stays focusable (for a tooltip that explains why). */
    ariaDisabled?: boolean
    ariaDescribedby?: string
    /** Names the button when its visible text alone is ambiguous (the same action on many rows). */
    ariaLabel?: string
    /** Blocks clicks and sets aria-busy while keeping the label and focus. */
    busy?: boolean
    onclick?: (event: MouseEvent) => void
    children: Snippet
  }

  let {
    variant = 'secondary',
    type = 'button',
    size = 'md',
    disabled = false,
    ariaDisabled = false,
    ariaDescribedby,
    ariaLabel,
    busy = false,
    onclick,
    children
  }: Props = $props()

  const style = $derived(buttonVariants[variant])

  function handleClick(event: MouseEvent): void {
    if (busy || disabled || ariaDisabled) {
      event.preventDefault()
      return
    }
    onclick?.(event)
  }
</script>

<button
  {type}
  {disabled}
  aria-disabled={ariaDisabled ? 'true' : undefined}
  aria-describedby={ariaDescribedby}
  aria-label={ariaLabel}
  onclick={handleClick}
  aria-busy={busy ? 'true' : undefined}
  data-variant={variant}
  class="inline-flex min-h-[var(--size-hit)] items-center justify-center gap-2 rounded-control border font-sans text-sm font-semibold tracking-label uppercase transition-shadow duration-(--duration-fast) focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 {size ===
  'icon'
    ? 'min-w-[var(--size-hit)] px-2'
    : 'px-4'} {style.base} {style.hover} {busy ? 'cursor-progress' : ''}"
>
  {#if busy}<span class="btn-spinner" aria-hidden="true"></span>{/if}{@render children()}
</button>

<style>
  .btn-spinner {
    width: 0.9em;
    height: 0.9em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 9999px;
    animation: btn-spin 0.8s linear infinite;
  }
  :global([data-motion='reduced']) .btn-spinner {
    animation: none;
  }
  @keyframes btn-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
