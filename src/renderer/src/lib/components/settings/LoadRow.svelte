<script lang="ts">
  import type { LoadItem, LoadRole } from '@shared/types/agent-load'
  import { exactTokens, formatTokens } from '../../format/tokens'
  import Toggle from '../ui/Toggle.svelte'

  interface Props {
    item: LoadItem
    brainOn: boolean
    workersOn: boolean
    onset: (role: LoadRole, on: boolean) => void
  }

  let { item, brainOn, workersOn, onset }: Props = $props()

  // Two-way for the input, reset whenever the stored selection changes.
  let brain = $derived(brainOn)
  let workers = $derived(workersOn)

  const KIND_NAMES = {
    mcp: 'MCP server',
    plugin: 'Plugin',
    skill: 'Skill',
    hook: 'Hook',
    'codex-mcp': 'Codex MCP server',
    'cursor-mcp': 'Cursor MCP server'
  } as const
  // The kind is part of the name: a Claude and a Codex server can share one.
  const name = $derived(`${item.label}, ${KIND_NAMES[item.kind]}`)
  const base = $derived(`load-${item.kind}-${item.key.replace(/[^A-Za-z0-9_-]/g, '_')}`)
</script>

<li
  data-load-item={item.key}
  class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border px-4 py-2 last:border-b-0"
>
  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
      <span class="text-sm font-semibold break-all text-text-bright">{item.label}</span>
      {#if item.detail}
        <span class="font-mono text-xs break-all text-text-faint">{item.detail}</span>
      {/if}
    </div>
    <p class="text-xs text-text-muted">
      {#if item.tokens === null}
        <span data-load-size>size unknown</span>
      {:else}
        <span data-load-size title="{exactTokens(item.tokens)} tokens"
          >about {formatTokens(item.tokens)} tokens per request</span
        >
      {/if}
      {#if item.note}<span> · {item.note}</span>{/if}
    </p>
  </div>
  <div class="flex shrink-0 items-center gap-4">
    <Toggle
      id="{base}-brain"
      label="{name}, Brain"
      labelHidden
      bind:checked={brain}
      onchange={() => onset('brain', brain)}
    />
    <Toggle
      id="{base}-workers"
      label="{name}, Workers"
      labelHidden
      bind:checked={workers}
      onchange={() => onset('workers', workers)}
    />
  </div>
</li>
