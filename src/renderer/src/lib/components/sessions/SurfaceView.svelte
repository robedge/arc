<script lang="ts">
  // SPIKE (A2UI): draws a `show_surface` panel with Arc's own controls. Throwaway.
  import {
    pathOf,
    readPointer,
    SURFACE_ACTION_PREFIX,
    writePointer,
    type Surface,
    type SurfaceNode
  } from '@shared/surface'
  import Button from '../ui/Button.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import SurfaceChart from './SurfaceChart.svelte'
  import { activeSession } from '../../stores/active-session.svelte'
  import { messageFor } from '../../ipc/messages'

  interface Props {
    surface: Surface
    sessionId: string
    messageId: number
  }

  let { surface, sessionId, messageId }: Props = $props()

  const byId = $derived(new Map(surface.components.map((c) => [c.id, c])))
  // The user's edits live here only: a reload shows the brain's original values again.
  // svelte-ignore state_referenced_locally
  let model = $state<Record<string, unknown>>(
    JSON.parse(JSON.stringify(surface.dataModel ?? {})) as Record<string, unknown>
  )
  let sent = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<string | null>(null)

  const MAX_DEPTH = 16
  const TEXT: Record<string, string> = {
    body: 'text-sm text-text',
    caption: 'text-xs text-text-muted',
    h1: 'text-lg font-semibold text-text-bright',
    h2: 'text-base font-semibold text-text-bright',
    h3: 'text-sm font-semibold tracking-label text-text-bright uppercase'
  }
  const TONE_TEXT: Record<string, string> = {
    neutral: 'text-text-muted',
    info: 'text-accent',
    positive: 'text-success',
    warning: 'text-attention',
    danger: 'text-danger'
  }
  const TONE_BOX: Record<string, string> = {
    neutral: 'border-border bg-surface-panel',
    info: 'border-accent/45 bg-accent/10',
    positive: 'border-success/45 bg-success/10',
    warning: 'border-attention/45 bg-attention/10',
    danger: 'border-danger/45 bg-danger/10'
  }
  const COLS: Record<number, string> = {
    1: 'sm:grid-cols-1',
    2: 'sm:grid-cols-2',
    3: 'sm:grid-cols-3',
    4: 'sm:grid-cols-4',
    5: 'sm:grid-cols-5',
    6: 'sm:grid-cols-6'
  }
  const ARROW: Record<string, string> = { up: '▲', down: '▼', flat: '■' }
  const INPUT =
    'w-full rounded-control border border-border-strong bg-surface-panel px-3 py-2 font-sans text-sm text-text placeholder:text-text-faint focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50'

  /** A literal, or the value its `@path` points at. */
  function resolve(value: unknown): unknown {
    const path = pathOf(value)
    return path === null ? value : readPointer(model, path)
  }

  function text(value: unknown): string {
    const v = resolve(value)
    if (v === undefined || v === null) return ''
    return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }

  function word(node: SurfaceNode, key: string, fallback: string): string {
    const v = node[key]
    return typeof v === 'string' ? v : fallback
  }

  /** Where an input writes: its binding, or a private slot when the brain gave a literal. */
  function slot(node: SurfaceNode): string {
    return pathOf(node['value']) ?? `/__local/${node.id}`
  }

  function inputValue(node: SurfaceNode): unknown {
    const local = readPointer(model, slot(node))
    return local === undefined ? resolve(node['value']) : local
  }

  function chosen(node: SurfaceNode): string[] {
    const v = inputValue(node)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  }

  function pick(node: SurfaceNode, value: string): void {
    const current = chosen(node)
    const multi = node['variant'] === 'multipleSelection'
    const next = multi
      ? current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value]
      : [value]
    writePointer(model, slot(node), next)
  }

  function options(node: SurfaceNode): { label: string; value: string }[] {
    const raw = node['options']
    if (!Array.isArray(raw)) return []
    return raw.flatMap((o: unknown) => {
      const value = (o as { value?: unknown } | null)?.value
      return typeof value === 'string'
        ? [{ label: text((o as { label?: unknown }).label) || value, value }]
        : []
    })
  }

  function points(node: SurfaceNode): { label: string; value: number }[] {
    const raw = resolve(node['data'])
    if (!Array.isArray(raw)) return []
    return raw.slice(0, 60).flatMap((p: unknown) => {
      const item = p as { label?: unknown; value?: unknown } | null
      return typeof item?.value === 'number' && Number.isFinite(item.value) && item.value >= 0
        ? [{ label: String(item.label ?? ''), value: item.value }]
        : []
    })
  }

  function rows(node: SurfaceNode): string[][] {
    const raw = resolve(node['rows'])
    if (!Array.isArray(raw)) return []
    return raw
      .slice(0, 100)
      .map((r: unknown) => (Array.isArray(r) ? r.map((cell) => text(cell)) : [text(r)]))
  }

  function columns(node: SurfaceNode): string[] {
    const raw = node['columns']
    return Array.isArray(raw) ? raw.map((c) => String(c)) : []
  }

  function labelOf(node: SurfaceNode): string {
    const child = typeof node['child'] === 'string' ? byId.get(node['child']) : undefined
    const label = child?.component === 'Text' ? text(child['text']) : ''
    return label || eventOf(node)?.name || 'Button'
  }

  function eventOf(node: SurfaceNode): { name: string; context: Record<string, unknown> } | null {
    const event = (node['action'] as { event?: { name?: unknown; context?: unknown } } | undefined)
      ?.event
    if (typeof event?.name !== 'string') return null
    const context =
      event.context !== null && typeof event.context === 'object'
        ? (event.context as Record<string, unknown>)
        : {}
    return { name: event.name, context }
  }

  async function fire(node: SurfaceNode): Promise<void> {
    const event = eventOf(node)
    if (busy || event === null) return
    busy = true
    error = null
    const context: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event.context)) context[key] = resolve(value) ?? null
    const payload = {
      surfaceId: surface.surfaceId,
      name: event.name,
      label: labelOf(node),
      sourceComponentId: node.id,
      context
    }
    const body = `${SURFACE_ACTION_PREFIX}${JSON.stringify(payload)}`
    const res = await window.arc.invoke('sessions:send-message', { sessionId, text: body })
    busy = false
    if (!res.ok) {
      error = messageFor(res.error)
      return
    }
    sent = labelOf(node)
    const now = Date.now()
    activeSession.addUserMessage({
      id: res.data.messageId,
      sessionId,
      role: 'user',
      content: body,
      state: 'complete',
      planId: null,
      createdAt: now,
      updatedAt: now
    })
  }
</script>

{#snippet kids(node: SurfaceNode, depth: number)}
  {#each Array.isArray(node['children']) ? node['children'] : [] as child, i (i)}
    {#if typeof child === 'string'}{@render draw(child, depth + 1)}{/if}
  {/each}
{/snippet}

{#snippet draw(nodeId: string, depth: number)}
  {@const c = byId.get(nodeId)}
  {#if c && depth <= MAX_DEPTH}
    {#if c.component === 'Column'}
      <div class="flex min-w-0 flex-col gap-3">{@render kids(c, depth)}</div>
    {:else if c.component === 'Row'}
      <div class="flex min-w-0 flex-wrap items-center gap-2">{@render kids(c, depth)}</div>
    {:else if c.component === 'Grid'}
      {@const n = typeof c['columns'] === 'number' ? c['columns'] : 2}
      <div class="grid min-w-0 grid-cols-1 gap-3 {COLS[n] ?? COLS[2]}">
        {@render kids(c, depth)}
      </div>
    {:else if c.component === 'Card'}
      <div class="min-w-0 rounded-hud border border-border bg-surface-panel p-3">
        {#if typeof c['child'] === 'string'}{@render draw(c['child'], depth + 1)}{/if}
      </div>
    {:else if c.component === 'Divider'}
      <hr class="w-full border-border" />
    {:else if c.component === 'Text'}
      <p
        class="[overflow-wrap:anywhere] whitespace-pre-wrap {TEXT[word(c, 'variant', 'body')] ??
          TEXT['body']}"
      >
        {text(c['text'])}
      </p>
    {:else if c.component === 'Badge'}
      {@const tone = word(c, 'tone', 'neutral')}
      <span
        class="inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs font-medium {TONE_BOX[
          tone
        ] ?? TONE_BOX['neutral']} {TONE_TEXT[tone] ?? ''}">{text(c['text'])}</span
      >
    {:else if c.component === 'Stat'}
      {@const tone = word(c, 'tone', word(c, 'trend', '') === 'down' ? 'neutral' : 'positive')}
      <div
        data-stat
        class="flex min-w-0 flex-col gap-1 rounded-hud border border-border bg-surface-panel p-3"
      >
        <span class="text-xs tracking-label text-text-muted uppercase">{text(c['label'])}</span>
        <span class="text-2xl font-semibold text-text-bright">{text(c['value'])}</span>
        {#if text(c['delta'])}
          <span class="text-xs font-medium {TONE_TEXT[tone] ?? TONE_TEXT['neutral']}"
            >{ARROW[word(c, 'trend', '')] ?? ''} {text(c['delta'])}</span
          >
        {/if}
        {#if text(c['note'])}<span class="text-xs text-text-muted">{text(c['note'])}</span>{/if}
      </div>
    {:else if c.component === 'Callout'}
      {@const tone = word(c, 'tone', 'info')}
      <div
        class="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-hud border p-3 {TONE_BOX[
          tone
        ] ?? TONE_BOX['info']}"
      >
        <div class="flex min-w-0 flex-col gap-1">
          <span class="text-sm font-semibold text-text-bright">{text(c['title'])}</span>
          {#if text(c['text'])}<span class="text-sm text-text">{text(c['text'])}</span>{/if}
        </div>
        {#if typeof c['child'] === 'string'}{@render draw(c['child'], depth + 1)}{/if}
      </div>
    {:else if c.component === 'Table'}
      <div class="min-w-0 overflow-x-auto">
        <table class="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {#each columns(c) as col, i (i)}
                <th
                  class="border-b border-border-strong px-2 py-1 text-xs tracking-label text-text-muted uppercase"
                  >{col}</th
                >
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows(c) as row, r (r)}
              <tr>
                {#each row as cell, i (i)}
                  <td class="border-b border-border px-2 py-1 [overflow-wrap:anywhere] text-text"
                    >{cell}</td
                  >
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else if c.component === 'BarChart' || c.component === 'LineChart'}
      <SurfaceChart
        kind={c.component === 'BarChart' ? 'bar' : 'line'}
        points={points(c)}
        title={text(c['title'])}
        subtitle={text(c['subtitle'])}
        unit={word(c, 'unit', '')}
        horizontal={c['orientation'] === 'horizontal'}
      />
    {:else if c.component === 'Button'}
      <Button
        variant={c['variant'] === 'primary' ? 'primary' : 'secondary'}
        {busy}
        onclick={() => void fire(c)}>{labelOf(c)}</Button
      >
    {:else if c.component === 'TextField'}
      {@const fieldId = `surface-${messageId}-${c.id}`}
      <div class="flex min-w-0 flex-col gap-1">
        <label for={fieldId} class="text-sm font-medium text-text">{text(c['label'])}</label>
        {#if c['variant'] === 'longText'}
          <textarea
            id={fieldId}
            rows="3"
            maxlength="4000"
            placeholder={text(c['placeholder'])}
            value={text(inputValue(c))}
            oninput={(e) => writePointer(model, slot(c), e.currentTarget.value)}
            class={INPUT}></textarea>
        {:else}
          <input
            id={fieldId}
            type="text"
            autocomplete="off"
            maxlength="2000"
            placeholder={text(c['placeholder'])}
            value={text(inputValue(c))}
            oninput={(e) => writePointer(model, slot(c), e.currentTarget.value)}
            class="min-h-[var(--size-hit)] {INPUT}"
          />
        {/if}
      </div>
    {:else if c.component === 'CheckBox'}
      <label class="flex min-h-[var(--size-hit)] items-center gap-2 text-sm text-text">
        <input
          type="checkbox"
          checked={inputValue(c) === true}
          onchange={(e) => writePointer(model, slot(c), e.currentTarget.checked)}
        />
        {text(c['label'])}
      </label>
    {:else if c.component === 'ChoicePicker'}
      {@const multi = c['variant'] === 'multipleSelection'}
      <fieldset class="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        {#if text(c['label'])}
          <legend class="p-0 text-sm font-medium text-text">{text(c['label'])}</legend>
        {/if}
        <div class="flex flex-wrap gap-2 pt-1">
          {#each options(c) as option (option.value)}
            {@const on = chosen(c).includes(option.value)}
            <button
              type="button"
              role={multi ? 'checkbox' : 'radio'}
              aria-checked={on}
              onclick={() => pick(c, option.value)}
              class="min-h-[var(--size-hit)] cursor-pointer rounded-control border px-3 text-sm focus:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 {on
                ? 'border-accent bg-accent/15 text-text-bright'
                : 'border-border-strong bg-surface-panel text-text'}">{option.label}</button
            >
          {/each}
        </div>
      </fieldset>
    {/if}
  {/if}
{/snippet}

<div data-surface={surface.surfaceId} class="flex w-full min-w-[16rem] flex-col gap-2">
  {@render draw('root', 0)}
  {#if sent !== null}
    <span class="text-xs tracking-label text-text-muted uppercase">Last sent: {sent}</span>
  {/if}
  {#if error}
    <ErrorText id="surface-{messageId}-error" message={error} />
  {/if}
</div>
