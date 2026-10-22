<script lang="ts">
  import ErrorText from '../ui/ErrorText.svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import * as pdfjs from 'pdfjs-dist'
  import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
  import IconButton from '../ui/IconButton.svelte'
  import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

  let { url }: { url: string } = $props()

  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

  /** Canvas pixel width: sharp when scaled to the panel; CSS sizes the page. */
  const RENDER_WIDTH = 1400
  const ZOOM_MIN = 0.5
  const ZOOM_MAX = 3
  let zoom = $state(1)
  const ratios = new SvelteMap<number, number>()
  let pageCount = $state(0)
  let current = $state(1)
  let error = $state<string | null>(null)
  let aspect = $state(1.4)
  let doc: PDFDocumentProxy | null = null
  const visible = new SvelteSet<number>()

  $effect(() => {
    const source = url
    let task: PDFDocumentLoadingTask | null = null
    let cancelled = false
    pageCount = 0
    current = 1
    error = null
    void (async () => {
      try {
        task = pdfjs.getDocument({ url: source })
        const loaded = await task.promise
        if (cancelled) {
          void task?.destroy()
          return
        }
        doc = loaded
        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        if (cancelled) return
        aspect = viewport.height / viewport.width
        pageCount = loaded.numPages
      } catch {
        if (!cancelled) error = "This PDF couldn't be displayed."
      }
    })()
    return () => {
      cancelled = true
      doc = null
      void task?.destroy()
    }
  })

  /** Renders the page into its canvas the first time it nears the viewport. */
  function lazyPage(node: HTMLElement, pageNumber: number) {
    const canvas = node.querySelector('canvas') as HTMLCanvasElement
    let started = false
    let destroyed = false
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !started) {
            started = true
            void render()
          }
        }
      },
      { rootMargin: '600px 0px' }
    )
    async function render(): Promise<void> {
      const target = doc
      if (!target) return
      try {
        const page = await target.getPage(pageNumber)
        if (destroyed) return
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: RENDER_WIDTH / base.width })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        await page.render({ canvas, viewport }).promise
      } catch {
        if (!destroyed) error = "This PDF couldn't be displayed."
      }
    }
    const visibility = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            visible.add(pageNumber)
            ratios.set(pageNumber, entry.intersectionRatio ?? 1)
          } else {
            visible.delete(pageNumber)
            ratios.delete(pageNumber)
          }
        }
        // The most visible page wins; ties go to the earlier page.
        let best = 0
        let bestRatio = -1
        for (const n of [...visible].sort((a, b) => a - b)) {
          const ratio = ratios.get(n) ?? 1
          if (ratio > bestRatio) {
            best = n
            bestRatio = ratio
          }
        }
        if (best > 0) current = best
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] }
    )
    observer.observe(node)
    visibility.observe(node)
    return {
      destroy() {
        destroyed = true
        observer.disconnect()
        visibility.disconnect()
        visible.delete(pageNumber)
        ratios.delete(pageNumber)
      }
    }
  }

  function stepZoom(delta: number): void {
    zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((zoom + delta) * 100) / 100))
  }
</script>

{#if error}
  <ErrorText message={error} />
{:else}
  <div class="flex min-h-0 flex-1 flex-col gap-2">
    <div class="flex shrink-0 items-center gap-2">
      <p class="text-sm text-text-muted">Page {current} of {pageCount || '…'}</p>
      <div class="ml-auto flex gap-1" role="group" aria-label="PDF zoom">
        <IconButton
          label="Zoom out"
          icon="minus"
          disabled={zoom <= ZOOM_MIN}
          onclick={() => stepZoom(-0.25)}
        />
        <IconButton
          label="Zoom in"
          icon="plus"
          disabled={zoom >= ZOOM_MAX}
          onclick={() => stepZoom(0.25)}
        />
      </div>
    </div>
    <div
      class="min-h-0 flex-1 overflow-auto rounded-control border border-border-strong bg-surface-raised p-3"
      aria-label="PDF pages"
      data-pdf-frame
    >
      <div class="mx-auto flex flex-col gap-3" style="width:{zoom * 100}%">
        {#each Array.from({ length: pageCount }, (_, i) => i + 1) as n (n)}
          <div use:lazyPage={n} style="aspect-ratio:1 / {aspect}">
            <canvas class="block w-full bg-paper" aria-label="Page {n}"></canvas>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}
