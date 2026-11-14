<script lang="ts">
  // SPIKE (A2UI): Arc's BarChart and LineChart, drawn as SVG with theme colors. Throwaway.
  interface Point {
    label: string
    value: number
  }

  interface Props {
    kind: 'bar' | 'line'
    points: Point[]
    title?: string
    subtitle?: string
    unit?: string
    horizontal?: boolean
  }

  let { kind, points, title = '', subtitle = '', unit = '', horizontal = false }: Props = $props()

  const W = 640
  const H = 260
  const LEFT = 64
  const RIGHT = 16
  const TOP = 12
  const BOTTOM = 30

  /** A round step that gives about four ticks. */
  function niceStep(max: number): number {
    const rough = max / 4
    const pow = 10 ** Math.floor(Math.log10(rough))
    const unitStep = [1, 2, 2.5, 5, 10].find((m) => m * pow >= rough) ?? 10
    return unitStep * pow
  }

  const max = $derived(Math.max(0, ...points.map((p) => p.value)))
  const step = $derived(max > 0 ? niceStep(max) : 1)
  const top = $derived(Math.max(step, Math.ceil(max / step) * step))
  const ticks = $derived(Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step))
  const plotW = W - LEFT - RIGHT
  const plotH = H - TOP - BOTTOM
  const slot = $derived(plotW / Math.max(1, points.length))
  const y = (value: number): number => TOP + plotH - (value / top) * plotH
  const x = (i: number): number => LEFT + slot * i + slot / 2
  const fmt = (n: number): string => String(Math.round(n * 100) / 100)
  const short = (label: string, room: number): string => {
    const fit = Math.max(3, Math.floor(room / 7))
    return label.length > fit ? `${label.slice(0, fit - 1)}…` : label
  }
  const line = $derived(
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(p.value)}`).join(' ')
  )
  const summary = $derived(
    points.map((p) => `${p.label}: ${fmt(p.value)}${unit ? ` ${unit}` : ''}`).join(', ')
  )
</script>

<figure data-chart={kind} class="m-0 flex min-w-0 flex-col gap-1">
  {#if title}<figcaption class="text-sm font-semibold text-text-bright">{title}</figcaption>{/if}
  {#if subtitle}<p class="text-xs text-text-muted">{subtitle}</p>{/if}
  {#if points.length === 0}
    <p class="text-xs text-text-muted">No data.</p>
  {:else if kind === 'bar' && horizontal}
    <div
      role="img"
      aria-label={summary}
      class="grid min-w-0 grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1 text-sm"
    >
      {#each points as p, i (i)}
        <span class="text-text-muted">{p.label}</span>
        <span class="h-3 min-w-0 rounded-control bg-surface-code">
          <span
            class="block h-3 rounded-control bg-accent"
            style:width="{top > 0 ? (p.value / top) * 100 : 0}%"
          ></span>
        </span>
        <span class="text-right font-mono text-text">{fmt(p.value)}{unit ? ` ${unit}` : ''}</span>
      {/each}
    </div>
  {:else}
    <svg viewBox="0 0 {W} {H}" role="img" aria-label={summary} class="h-auto w-full max-w-[40rem]">
      {#each ticks as tick (tick)}
        <line
          x1={LEFT}
          x2={W - RIGHT}
          y1={y(tick)}
          y2={y(tick)}
          class="stroke-border"
          stroke-width="1"
        />
        <text x={LEFT - 8} y={y(tick) + 4} text-anchor="end" class="fill-text-muted text-[11px]"
          >{fmt(tick)}{unit ? ` ${unit}` : ''}</text
        >
      {/each}
      {#if kind === 'bar'}
        {#each points as p, i (i)}
          {@const w = Math.min(56, slot * 0.6)}
          <rect
            x={x(i) - w / 2}
            y={y(p.value)}
            width={w}
            height={Math.max(0, TOP + plotH - y(p.value))}
            rx="3"
            class="fill-accent"
          >
            <title>{p.label}: {fmt(p.value)}{unit ? ` ${unit}` : ''}</title>
          </rect>
        {/each}
      {:else}
        <path d={line} fill="none" class="stroke-accent" stroke-width="2" />
        {#each points as p, i (i)}
          <circle cx={x(i)} cy={y(p.value)} r="3.5" class="fill-accent">
            <title>{p.label}: {fmt(p.value)}{unit ? ` ${unit}` : ''}</title>
          </circle>
        {/each}
      {/if}
      {#each points as p, i (i)}
        {#if points.length <= 12 || i % Math.ceil(points.length / 12) === 0}
          <text x={x(i)} y={H - 10} text-anchor="middle" class="fill-text-muted text-[11px]"
            >{short(
              p.label,
              points.length <= 12 ? slot : slot * Math.ceil(points.length / 12)
            )}</text
          >
        {/if}
      {/each}
    </svg>
  {/if}
</figure>
