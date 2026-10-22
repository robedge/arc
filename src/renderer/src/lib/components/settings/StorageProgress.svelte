<script lang="ts">
  import type { StorageProgress } from '../../stores/storage.svelte'

  interface Props {
    progress: StorageProgress | null
  }

  let { progress }: Props = $props()

  const LABELS = {
    preparing: 'Preparing…',
    copying: 'Copying files',
    verifying: 'Verifying files',
    exporting: 'Exporting files',
    switching: 'Switching storage',
    cleaning: 'Cleaning up',
    'rolling-back': 'Something went wrong. Rolling back…',
    done: 'Done'
  } as const

  const percent = $derived(
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.done / progress.total) * 100))
      : 0
  )
  const rollingBack = $derived(progress?.phase === 'rolling-back')
</script>

<div role="status" aria-live="polite" class="flex flex-col gap-1 text-sm text-text">
  {#if progress}
    <div class="flex items-baseline justify-between gap-3">
      <span
        >{LABELS[
          progress.phase
        ]}{#if progress.total > 0 && progress.phase !== 'rolling-back' && progress.phase !== 'done'}
          &nbsp;<span class="font-mono text-text-muted">({progress.done} of {progress.total})</span
          >{/if}</span
      >
      {#if progress.total > 0}
        <span class="font-mono text-xs text-text-muted" data-progress-percent>{percent}%</span>
      {/if}
    </div>
    {#if progress.total > 0}
      <div
        role="progressbar"
        aria-label="Storage progress"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        class="h-2 w-full overflow-hidden rounded-hud border border-border-strong bg-surface-code"
      >
        <div
          data-progress-fill
          class="h-full transition-[width] duration-(--duration-base) {rollingBack
            ? 'bg-attention'
            : 'bg-accent shadow-glow-accent'}"
          style="width:{percent}%"
        ></div>
      </div>
    {/if}
  {:else}
    Working…
  {/if}
</div>
