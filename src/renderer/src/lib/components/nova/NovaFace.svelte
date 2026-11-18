<script lang="ts">
  import { onMount } from 'svelte'
  import portrait from '../../../assets/nova/base.webp'
  import { loadFaceAssets, type FaceAssets } from '../../nova/face-assets'
  import { createFaceDriver, type FaceDriver, type FacePose } from '../../nova/face-driver'
  import { drawFace } from '../../nova/face-render'
  import { getPlayer } from '../../nova/engines'
  import { motion } from '../../stores/motion.svelte'
  import { nova } from '../../stores/nova.svelte'

  interface Props {
    /** Test-only attribute `data-nova-pose` (set only with fake voice models). */
    exposePose?: boolean
    /** Design Preview and tests: no audio, no microphone. */
    preview?: boolean
    load?: () => Promise<FaceAssets>
  }

  let { exposePose = false, preview = false, load = loadFaceAssets }: Props = $props()

  let host: HTMLDivElement | undefined = $state()
  let canvas: HTMLCanvasElement | undefined = $state()
  let side = $state(0)
  /** The animated canvas is in use; false shows the plain portrait (loading or failed). */
  let animated = $state(false)

  const reducedStill = (): boolean => motion.reduced

  onMount(() => {
    if (!host) return
    const el: HTMLDivElement = host
    let assets: FaceAssets | undefined
    let raf = 0
    let wake: ReturnType<typeof setTimeout> | 0 = 0
    let last = 0
    let alive = true
    let visible = true
    let lastPose = ''
    let driver: FaceDriver | undefined

    const measure = (width: number, height: number): void => {
      side = Math.floor(Math.min(width, height))
    }
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(([entry]) => {
            if (entry) measure(entry.contentRect.width, entry.contentRect.height)
          })
        : null
    observer?.observe(el)
    const intersection =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true
            schedule()
          })
        : null
    intersection?.observe(el)

    const paused = (): boolean => document.hidden || !visible || el.closest('[inert]') !== null

    function schedule(): void {
      if (!alive || !assets || raf || wake) return
      raf = requestAnimationFrame(frame)
    }

    function frame(now: number): void {
      raf = 0
      if (!alive || !assets || !canvas || !driver) return
      if (paused()) {
        last = 0
        // Hidden, closed or covered: draw nothing, look again in a quarter of a second.
        wake = setTimeout(() => {
          wake = 0
          schedule()
        }, 250)
        return
      }
      const dt = last ? (now - last) / 1000 : 0
      last = now
      const state = nova.state
      const player = getPlayer()
      const pose: FacePose = driver.step({
        dt,
        state,
        speechLevel: state === 'speaking' ? player.level : 0,
        mouth: state === 'speaking' ? player.mouth?.() : undefined,
        micLevel: state === 'listening' ? nova.micLevel : 0,
        reduced: reducedStill()
      })
      const dpr = window.devicePixelRatio || 1
      const px = Math.max(1, Math.round(canvas.clientWidth * dpr))
      if (canvas.width !== px) {
        canvas.width = px
        canvas.height = px
      }
      const ctx = canvas.getContext('2d')
      if (ctx) drawFace(ctx, assets, pose, px, dpr)
      el.style.setProperty('--nova-glow', pose.glow.toFixed(3))
      if (exposePose) {
        const text = JSON.stringify({
          mouthLevel: Math.round(pose.mouthLevel * 10) / 10,
          mouthOpen: Math.round(pose.mouthOpen * 100) / 100,
          blink: pose.blinkFrame ?? null,
          glance: pose.glance ?? null
        })
        if (text !== lastPose) {
          lastPose = text
          el.setAttribute('data-nova-pose', text)
        }
      }
      raf = requestAnimationFrame(frame)
    }

    const onVisibility = (): void => {
      last = 0
    }
    document.addEventListener('visibilitychange', onVisibility)

    if (!preview) {
      load()
        .then((loaded) => {
          if (!alive) return
          assets = loaded
          driver = createFaceDriver(Math.random, {
            blinkSequence: loaded.blinkSequence,
            blinkTimingsMs: loaded.blinkTimingsMs,
            mouthLevels: loaded.mouthLevels,
            mouthOpenings: loaded.mouthOpenings
          })
          animated = true
          schedule()
        })
        .catch((error: unknown) => {
          console.error('Nova face assets failed; showing the plain portrait', error)
        })
    }

    return () => {
      alive = false
      if (raf) cancelAnimationFrame(raf)
      if (wake) clearTimeout(wake)
      observer?.disconnect()
      intersection?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  })
</script>

<div
  bind:this={host}
  class="nova-face flex h-full min-h-0 w-full items-center justify-center"
  data-nova-portrait
  role="img"
  aria-label="Nova's portrait"
>
  <div class="nova-glow rounded-control" style:width="{side || 0}px" style:height="{side || 0}px">
    {#if animated}
      <canvas
        bind:this={canvas}
        class="block h-full w-full rounded-control"
        data-nova-canvas
        aria-hidden="true"
      ></canvas>
    {:else}
      <img
        src={portrait}
        alt=""
        class="block h-full w-full rounded-control object-contain"
        data-nova-plain
      />
    {/if}
  </div>
</div>

<style>
  .nova-glow {
    box-shadow:
      0 0 calc(10px + var(--nova-glow, 0.18) * 34px)
        color-mix(in srgb, var(--color-accent) calc(var(--nova-glow, 0.18) * 65%), transparent),
      inset 0 0 calc(var(--nova-glow, 0.18) * 18px)
        color-mix(in srgb, var(--color-accent) calc(var(--nova-glow, 0.18) * 35%), transparent);
  }
</style>
