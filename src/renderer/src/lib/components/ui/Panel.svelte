<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLAttributes } from 'svelte/elements'

  interface Props extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
    brackets?: 'diag' | 'none'
    title?: string
    as?: 'section' | 'div' | 'nav' | 'aside' | 'article' | 'main'
    /** The body becomes the panel's scroller. */
    scroll?: boolean
    tone?: 'default' | 'accent' | 'attention'
    drawIn?: boolean
    header?: Snippet
    footer?: Snippet
    children?: Snippet
  }

  let {
    brackets = 'diag',
    title,
    as = 'section',
    scroll = false,
    tone = 'default',
    drawIn = false,
    header,
    footer,
    children,
    class: className = '',
    ...rest
  }: Props = $props()
</script>

<svelte:element
  this={as}
  {...rest}
  class="hud-panel relative flex min-h-0 min-w-0 flex-col border bg-surface-panel {className}"
  data-tone={tone}
  data-draw-in={drawIn ? 'true' : undefined}
>
  {#if brackets === 'diag'}
    <span class="hud-bracket hud-bracket-tl" data-bracket="tl" aria-hidden="true"></span>
    <span class="hud-bracket hud-bracket-br" data-bracket="br" aria-hidden="true"></span>
  {/if}
  {#if title || header}
    <div class="shrink-0 px-3 pt-2">
      {#if title}
        <h2 class="font-display text-sm tracking-title text-text-muted uppercase">{title}</h2>
      {/if}
      {@render header?.()}
    </div>
  {/if}
  <div class="min-h-0 min-w-0 flex-1 {scroll ? 'overflow-auto' : ''}" data-panel-body>
    {@render children?.()}
  </div>
  {#if footer}
    <div class="shrink-0 px-3 pb-2">{@render footer()}</div>
  {/if}
</svelte:element>

<style>
  .hud-panel {
    border-color: var(--color-border);
    border-radius: var(--radius-hud);
  }
  .hud-panel[data-tone='accent'] {
    border-color: var(--color-border-strong);
    box-shadow: var(--shadow-glow-accent);
  }
  .hud-panel[data-tone='attention'] {
    border-color: var(--color-attention);
    box-shadow: var(--shadow-glow-attention);
  }
  .hud-bracket {
    position: absolute;
    width: var(--size-bracket);
    height: var(--size-bracket);
    pointer-events: none;
    border-color: var(--color-accent);
    border-style: solid;
    border-width: 0;
  }
  .hud-bracket-tl {
    top: -1px;
    left: -1px;
    border-top-width: 2px;
    border-left-width: 2px;
  }
  .hud-bracket-br {
    right: -1px;
    bottom: -1px;
    border-right-width: 2px;
    border-bottom-width: 2px;
  }
  .hud-panel[data-draw-in] {
    animation: panel-draw var(--duration-draw) var(--ease-hud) both;
  }
  @keyframes panel-draw {
    from {
      opacity: 0;
      transform: scale(0.985);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }
</style>
