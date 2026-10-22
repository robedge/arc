<script lang="ts">
  import IconButton from '../ui/IconButton.svelte'

  let { url, alt }: { url: string; alt: string } = $props()

  let fit = $state(true)
  let zoom = $state(1)

  function setActual(): void {
    fit = false
    zoom = 1
  }
  function step(delta: number): void {
    fit = false
    zoom = Math.min(8, Math.max(0.1, Math.round((zoom + delta) * 10) / 10))
  }
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2">
  <div class="flex shrink-0 items-center gap-1" role="group" aria-label="Image zoom">
    <IconButton
      label="Fit"
      icon="fit"
      variant={fit ? 'primary' : 'secondary'}
      onclick={() => (fit = true)}
    />
    <IconButton
      label="100%"
      icon="actual"
      variant={!fit && zoom === 1 ? 'primary' : 'secondary'}
      onclick={setActual}
    />
    <IconButton label="Zoom out" icon="minus" onclick={() => step(-0.25)} />
    <IconButton label="Zoom in" icon="plus" onclick={() => step(0.25)} />
  </div>
  <div
    class="min-h-0 flex-1 overflow-auto rounded-control border border-border bg-surface-raised p-3"
    data-image-frame
  >
    <img
      src={url}
      {alt}
      class={fit ? 'size-full object-contain' : 'max-w-none'}
      style={fit ? undefined : `zoom:${zoom}`}
    />
  </div>
</div>
