<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /** Receives the absolute paths of the dropped files/folders. */
    ondrop: (paths: string[]) => void
    class?: string
    children: Snippet
  }

  let { ondrop, class: className = '', children }: Props = $props()

  let active = $state(false)

  function hasFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files')
  }

  function ondragenter(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    active = true
  }

  function ondragover(event: DragEvent): void {
    if (!hasFiles(event)) return
    event.preventDefault()
    // Tell the window-level guard this drop target handled the event.
    event.stopPropagation()
    active = true
  }

  function ondragleave(event: DragEvent): void {
    const next = event.relatedTarget
    if (next instanceof Node && (event.currentTarget as Node).contains(next)) return
    active = false
  }

  function onDrop(event: DragEvent): void {
    event.preventDefault()
    event.stopPropagation()
    active = false
    // Paths must be read synchronously: the DataTransfer is cleared after the handler returns.
    const files = Array.from(event.dataTransfer?.files ?? [])
    const paths = files.map((file) => window.harness.getPathForFile(file)).filter((p) => p !== '')
    if (paths.length > 0) ondrop(paths)
  }
</script>

<div
  role="region"
  class="rounded-hud border-2 border-dashed p-1 {className} {active
    ? 'border-accent bg-accent/10 shadow-glow-accent'
    : 'border-transparent'}"
  {ondragenter}
  {ondragover}
  {ondragleave}
  ondrop={onDrop}
>
  {@render children()}
</div>
