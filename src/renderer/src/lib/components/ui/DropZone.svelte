<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /** Receives the absolute paths of the dropped files/folders. */
    ondrop: (paths: string[]) => void
    /** Files that were dropped but gave no path (dragged from a browser), so they cannot be read. */
    onunreadable?: (files: File[]) => void
    /** Shown centred over the zone while files are dragged over it. */
    label?: string
    /** Shows the active state without a drag; for the Design Preview, which has no real drag. */
    forceActive?: boolean
    class?: string
    children: Snippet
  }

  let {
    ondrop,
    onunreadable,
    label,
    forceActive = false,
    class: className = '',
    children
  }: Props = $props()

  let dragging = $state(false)
  const active = $derived(dragging || forceActive)

  function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files')
  }

  function ondragenter(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    dragging = true
  }

  function ondragover(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    // Tell the window-level guard this drop target handled the event.
    event.stopPropagation()
    dragging = true
  }

  function ondragleave(event: DragEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && (event.currentTarget as Node).contains(next)) return
    dragging = false
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    event.stopPropagation()
    dragging = false
    // Paths must be read synchronously: the DataTransfer is cleared after the handler returns.
    const files = Array.from(event.dataTransfer?.files ?? [])
    const withPaths = files.map((file) => ({ file, path: window.arc.getPathForFile(file) }))
    const paths = withPaths.map((entry) => entry.path).filter((p) => p !== '')
    if (paths.length > 0) ondrop(paths)
    const unreadable = withPaths.filter((entry) => entry.path === '').map((entry) => entry.file)
    if (unreadable.length > 0) onunreadable?.(unreadable)
  }
</script>

<div
  role="region"
  class="relative rounded-hud border-2 border-dashed p-1 {className} {active
    ? 'border-accent bg-accent/10 shadow-glow-accent'
    : 'border-transparent'}"
  {ondragenter}
  {ondragover}
  {ondragleave}
  ondrop={onDrop}
>
  {@render children()}
  {#if label && active}
    <div
      aria-hidden="true"
      data-drop-label
      class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-hud bg-surface-panel/80 font-display text-sm tracking-label text-accent uppercase"
    >
      {label}
    </div>
  {/if}
</div>
