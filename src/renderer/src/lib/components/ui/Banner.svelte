<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'
  import { messageKinds } from './kinds'

  interface Props {
    kind?: 'info' | 'warning' | 'error'
    /** Overrides the live-region role the kind implies. */
    role?: 'status' | 'alert'
    title?: string
    class?: string
    children?: Snippet
    actions?: Snippet
  }

  let { kind = 'warning', role, title, class: className = '', children, actions }: Props = $props()
  const style = $derived(messageKinds[kind])
</script>

<div
  role={role ?? (kind === 'info' ? 'status' : 'alert')}
  data-kind={kind}
  class="relative flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-hud border px-3 py-2 text-sm text-text {style.border} {style.bg} {className}"
>
  <span class="banner-bracket" aria-hidden="true" data-bracket="tl"></span>
  <span class="banner-bracket banner-bracket-br" aria-hidden="true" data-bracket="br"></span>
  <div class="flex min-w-0 items-start gap-2">
    <Icon name={style.icon} size={18} class="mt-0.5 {style.text}" />
    <div class="min-w-0">
      {#if title}<p class="font-semibold">{title}</p>{/if}
      {@render children?.()}
    </div>
  </div>
  {#if actions}
    <div class="flex shrink-0 gap-2">{@render actions()}</div>
  {/if}
</div>

<style>
  .banner-bracket {
    position: absolute;
    top: -1px;
    left: -1px;
    width: 10px;
    height: 10px;
    border-top: 2px solid currentColor;
    border-left: 2px solid currentColor;
    pointer-events: none;
  }
  .banner-bracket-br {
    top: auto;
    left: auto;
    right: -1px;
    bottom: -1px;
    border: 0;
    border-right: 2px solid currentColor;
    border-bottom: 2px solid currentColor;
  }
</style>
