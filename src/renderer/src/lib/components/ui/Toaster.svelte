<script lang="ts">
  import { toasts } from '../../stores/toasts.svelte'
  import Icon from './Icon.svelte'
  import { messageKinds } from './kinds'
</script>

<div class="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
  {#each toasts.list as toast (toast.id)}
    {@const style = messageKinds[toast.kind]}
    <div
      role="status"
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
      data-kind={toast.kind}
      class="toast pointer-events-auto flex max-w-sm items-start gap-2 rounded-hud border bg-surface-raised px-3 py-2 text-sm text-text shadow-lg {style.border}"
    >
      <Icon name={style.icon} size={18} class="mt-0.5 {style.text}" />
      <span class="whitespace-pre-line">{toast.message}</span>
    </div>
  {/each}
</div>

<style>
  .toast {
    animation: toast-in var(--duration-draw) var(--ease-hud) both;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
</style>
