<script lang="ts">
  import { onMount } from 'svelte'
  import { providerIds } from '@shared/provider-label'
  import type { DailyUsage, UsageRange } from '@shared/types/usage'
  import { exactTokens, formatTokens } from '../../format/tokens'
  import { motion } from '../../stores/motion.svelte'
  import { providerText } from './labels'

  interface Props {
    daily: readonly DailyUsage[]
    range: UsageRange
    total: number
  }

  let { daily, range, total }: Props = $props()

  // The chart is drawn in real pixels: a fixed compact height, and a width measured from the container,
  // so text stays at UI size and bars never stretch with the window.
  const H = 176
  const LEFT = 40
  const RIGHT = 8
  const TOP = 8
  const BOTTOM = 24
  const MAX_BAR = 28
  const plotH = H - TOP - BOTTOM
  let W = $state(640)
  let wrap: HTMLDivElement | undefined = $state()
  const plotW = $derived(Math.max(1, W - LEFT - RIGHT))

  const rangeText: Record<UsageRange, string> = {
    today: 'today',
    '7d': 'the last 7 days',
    '30d': 'the last 30 days',
    all: 'all time'
  }
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]

  /** Providers with usage, in provider order (Claude, Codex, Cursor) then any other, so a stack always reads the same. */
  const providers = $derived.by(() => {
    const seen: string[] = []
    for (const d of daily)
      for (const [p, n] of Object.entries(d.byProvider))
        if (n > 0 && !seen.includes(p)) seen.push(p)
    const order: readonly string[] = providerIds
    return seen.sort((a, b) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib) || a.localeCompare(b)
    })
  })

  const dayTotal = (d: DailyUsage): number =>
    Object.values(d.byProvider).reduce((sum, n) => sum + n, 0)

  /** Three steps of a round size that together cover the tallest day. */
  const step = $derived.by(() => {
    const max = Math.max(1, ...daily.map(dayTotal))
    const raw = max / 3
    const pow = 10 ** Math.floor(Math.log10(raw))
    const unit = [1, 2, 2.5, 5, 10].find((u) => u * pow >= raw) ?? 10
    return Math.max(1, unit * pow)
  })
  const yMax = $derived(step * 3)
  const ticks = $derived([1, 2, 3].map((i) => step * i))
  const y = (value: number): number => TOP + plotH - (value / yMax) * plotH

  const band = $derived(plotW / Math.max(1, daily.length))
  const barW = $derived(Math.max(1, Math.min(band * 0.7, MAX_BAR)))
  const bandX = (i: number): number => LEFT + i * band
  const centerX = (i: number): number => bandX(i) + band / 2

  function dateText(day: string): string {
    const [, m, d] = day.split('-')
    return `${MONTHS[Number(m) - 1] ?? ''} ${Number(d)}`
  }

  /** Which days get an x label: all for a week, every 5th for a month, the first day of each month for all time. */
  const labelled = $derived.by(() => {
    const out: number[] = []
    if (range === 'all') {
      const firsts: number[] = []
      let month = ''
      daily.forEach((d, i) => {
        const key = d.day.slice(0, 7)
        if (key !== month) firsts.push(i)
        month = key
      })
      const stride = Math.max(1, Math.ceil(firsts.length / 8))
      firsts.forEach((i, n) => n % stride === 0 && out.push(i))
    } else if (range === '30d') {
      daily.forEach((_d, i) => i % 5 === 0 && out.push(i))
    } else {
      daily.forEach((_d, i) => out.push(i))
    }
    return out
  })
  const labelText = (i: number): string => {
    const day = daily[i]?.day ?? ''
    return range === 'all' ? (MONTHS[Number(day.slice(5, 7)) - 1] ?? '') : dateText(day)
  }

  function segments(d: DailyUsage): { provider: string; value: number; from: number }[] {
    let from = 0
    return providers
      .filter((p) => (d.byProvider[p] ?? 0) > 0)
      .map((provider) => {
        const value = d.byProvider[provider] ?? 0
        const seg = { provider, value, from }
        from += value
        return seg
      })
  }

  function dayLabel(d: DailyUsage): string {
    const parts = providers
      .filter((p) => (d.byProvider[p] ?? 0) > 0)
      .map((p) => `${providerText(p)} ${exactTokens(d.byProvider[p] ?? 0)} tokens`)
    return `${dateText(d.day)}: ${parts.length > 0 ? parts.join(', ') : 'no usage'}`
  }

  // Claude is solid, Codex diagonal stripes, Cursor dots; any other provider the neutral hatch.
  const fillFor = (p: string): string =>
    p === 'claude'
      ? 'var(--color-chart-claude)'
      : p === 'codex'
        ? 'url(#chart-hatch-codex)'
        : p === 'cursor'
          ? 'url(#chart-dots-cursor)'
          : 'url(#chart-hatch-other)'
  const edgeFor = (p: string): string =>
    p === 'claude'
      ? 'var(--color-chart-claude)'
      : p === 'codex'
        ? 'var(--color-chart-codex)'
        : p === 'cursor'
          ? 'var(--color-chart-cursor)'
          : 'var(--color-text-muted)'

  let active = $state<number | null>(null)
  let current = $state(0)
  let hovered = $state<number | null>(null)
  const shown = $derived(hovered ?? active)
  let groups: (SVGGElement | undefined)[] = $state([])
  let showTable = $state(false)

  // Bars grow in once when the chart first appears; never under reduced motion, and never on later updates.
  let intro = $state(!motion.reduced)
  onMount(() => {
    const measure = (): void => {
      const w = wrap?.clientWidth ?? 0
      if (w > 0) W = w
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    if (wrap) observer?.observe(wrap)
    const timer = setTimeout(() => (intro = false), 400)
    return () => {
      clearTimeout(timer)
      observer?.disconnect()
    }
  })

  function onkeydown(event: KeyboardEvent, i: number): void {
    const last = daily.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? Math.min(last, i + 1)
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? Math.max(0, i - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    current = next
    groups[next]?.focus()
  }

  const focusIndex = $derived(Math.min(current, Math.max(0, daily.length - 1)))
  const tipDay = $derived(shown === null ? null : (daily[shown] ?? null))
</script>

<section aria-labelledby="usage-daily" class="flex flex-col gap-3" data-daily-chart-section>
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 id="usage-daily" class="text-sm font-semibold tracking-label text-text-muted uppercase">
      Day by day
    </h2>
    <button
      type="button"
      class="inline-flex min-h-8 items-center rounded-control border border-border px-2.5 text-xs text-text-muted hover:border-border-strong hover:text-text-bright focus:outline-none focus-visible:shadow-focus"
      aria-pressed={showTable}
      onclick={() => (showTable = !showTable)}>{showTable ? 'Hide table' : 'Show as table'}</button
    >
  </div>

  <div class="relative" data-chart-wrap bind:this={wrap}>
    <svg
      viewBox="0 0 {W} {H}"
      width={W}
      height={H}
      class="block max-w-full"
      role="img"
      aria-labelledby="usage-chart-title"
      data-daily-chart
      data-intro={intro ? 'true' : undefined}
    >
      <title id="usage-chart-title"
        >Daily token usage for {rangeText[range]}: {exactTokens(total)} tokens in total</title
      >
      <defs>
        <pattern
          id="chart-hatch-codex"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="var(--color-surface-code)" />
          <rect width="3" height="6" fill="var(--color-chart-codex)" />
        </pattern>
        <pattern id="chart-dots-cursor" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="var(--color-surface-code)" />
          <circle cx="3" cy="3" r="1.75" fill="var(--color-chart-cursor)" />
        </pattern>
        <pattern
          id="chart-hatch-other"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(-45)"
        >
          <rect width="6" height="6" fill="var(--color-surface-code)" />
          <rect width="3" height="6" fill="var(--color-text-muted)" />
        </pattern>
      </defs>

      {#each ticks as tick (tick)}
        <line x1={LEFT} x2={W - RIGHT} y1={y(tick)} y2={y(tick)} stroke="var(--color-border)" />
        <text
          x={LEFT - 6}
          y={y(tick)}
          text-anchor="end"
          dominant-baseline="middle"
          class="chart-label">{formatTokens(tick)}</text
        >
      {/each}
      <line x1={LEFT} x2={W - RIGHT} y1={y(0)} y2={y(0)} stroke="var(--color-line-faint)" />
      <text x={LEFT - 6} y={y(0)} text-anchor="end" dominant-baseline="middle" class="chart-label"
        >0</text
      >

      {#each daily as d, i (d.day)}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
        <g
          bind:this={groups[i]}
          role="img"
          tabindex={i === focusIndex ? 0 : -1}
          aria-label={dayLabel(d)}
          data-day={d.day}
          class="chart-day"
          onfocus={() => {
            current = i
            active = i
          }}
          onblur={() => (active = null)}
          onmouseenter={() => (hovered = i)}
          onmouseleave={() => (hovered = null)}
          onkeydown={(e) => onkeydown(e, i)}
        >
          <rect x={bandX(i)} y={TOP} width={band} height={plotH} fill="transparent" />
          {#if shown === i}
            <rect
              x={bandX(i)}
              y={TOP}
              width={band}
              height={plotH}
              fill="var(--color-surface-hover)"
            />
          {/if}
          <g class={intro ? 'chart-grow' : undefined}>
            {#each segments(d) as seg (seg.provider)}
              <rect
                x={centerX(i) - barW / 2}
                y={y(seg.from + seg.value)}
                width={barW}
                height={Math.max(1, y(seg.from) - y(seg.from + seg.value))}
                fill={fillFor(seg.provider)}
                stroke={edgeFor(seg.provider)}
                stroke-width="1.5"
                data-segment={seg.provider}
              />
            {/each}
          </g>
        </g>
      {/each}

      {#each labelled as i (i)}
        <text x={centerX(i)} y={H - 8} text-anchor="middle" class="chart-label">{labelText(i)}</text
        >
      {/each}
    </svg>

    {#if tipDay && shown !== null}
      <div
        class="pointer-events-none absolute z-10 -translate-x-1/2 rounded-hud border border-border-strong bg-surface-raised px-2.5 py-1.5 text-xs whitespace-nowrap text-text shadow-glow-accent"
        style="left: {centerX(shown)}px; top: 0"
        aria-hidden="true"
        data-chart-tooltip
      >
        <div class="text-text-bright">{dateText(tipDay.day)}</div>
        {#each providers as p (p)}
          <div class="tabular-nums">
            {providerText(p)}: {exactTokens(tipDay.byProvider[p] ?? 0)}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <ul class="flex flex-wrap gap-4 text-xs text-text-muted" data-chart-legend>
    {#each providers as p (p)}
      <li class="inline-flex items-center gap-1.5">
        <svg width="14" height="14" aria-hidden="true">
          <rect width="14" height="14" fill={fillFor(p)} stroke={edgeFor(p)} stroke-width="1.5" />
        </svg>
        {providerText(p)}
      </li>
    {/each}
  </ul>

  <div class={showTable ? 'overflow-x-auto' : 'sr-only'} data-chart-table-wrap>
    <table class="w-full text-sm tabular-nums" data-chart-table>
      <caption class="sr-only">Tokens used per day for {rangeText[range]}</caption>
      <thead>
        <tr class="text-left text-text-muted">
          <th scope="col" class="py-1.5 pr-4 font-normal">Date</th>
          {#each providers as p (p)}
            <th scope="col" class="py-1.5 pr-4 font-normal">{providerText(p)}</th>
          {/each}
          <th scope="col" class="py-1.5 font-normal">Total</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-border">
        {#each daily as d (d.day)}
          <tr data-chart-row={d.day}>
            <th scope="row" class="py-1.5 pr-4 text-left font-normal">{d.day}</th>
            {#each providers as p (p)}
              <td class="py-1.5 pr-4">{exactTokens(d.byProvider[p] ?? 0)}</td>
            {/each}
            <td class="py-1.5">{exactTokens(dayTotal(d))}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</section>

<style>
  .chart-label {
    fill: var(--color-text-muted);
    font-size: 11px;
    font-family: var(--font-sans);
  }
  .chart-day {
    cursor: default;
  }
  .chart-day:focus {
    outline: none;
  }
  .chart-day:focus-visible > rect:first-child {
    stroke: var(--color-accent);
    stroke-width: 2;
  }
  .chart-grow {
    transform-box: fill-box;
    transform-origin: bottom;
    animation: chart-grow var(--duration-draw) var(--ease-hud) both;
  }
  @keyframes chart-grow {
    from {
      transform: scaleY(0);
    }
    to {
      transform: scaleY(1);
    }
  }
</style>
