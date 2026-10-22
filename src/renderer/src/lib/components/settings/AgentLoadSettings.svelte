<script lang="ts">
  import { onMount } from 'svelte'
  import type { LoadItem, LoadKind, LoadRole } from '@shared/types/agent-load'
  import { exactTokens, formatTokens } from '../../format/tokens'
  import {
    agentLoad,
    type CodexGroupState,
    type CursorGroupState
  } from '../../stores/agent-load.svelte'
  import { settings } from '../../stores/settings.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import ErrorText from '../ui/ErrorText.svelte'
  import LoadRow from './LoadRow.svelte'

  interface Props {
    /** Fixed content for the Design Preview, which must not touch the store or IPC. */
    preview?: {
      items: LoadItem[]
      off?: { brain: string[]; workers: string[] }
      codex?: CodexGroupState
      cursor?: CursorGroupState
    }
  }

  let { preview }: Props = $props()

  const GROUPS: { kind: LoadKind; title: string }[] = [
    { kind: 'mcp', title: 'MCP servers' },
    { kind: 'plugin', title: 'Plugins' },
    { kind: 'skill', title: 'Skills' },
    { kind: 'hook', title: 'Hooks' },
    { kind: 'codex-mcp', title: 'Codex MCP servers' },
    { kind: 'cursor-mcp', title: 'Cursor MCP servers' }
  ]

  const items = $derived(preview ? preview.items : agentLoad.items)
  const off = $derived(preview?.off ?? agentLoad.off)

  function isOn(key: string, role: LoadRole): boolean {
    return !off[role].includes(key)
  }

  const totals = $derived.by(() => {
    const out = { brain: { tokens: 0, unknown: 0 }, workers: { tokens: 0, unknown: 0 } }
    for (const role of ['brain', 'workers'] as const) {
      for (const item of items) {
        if (!isOn(item.key, role)) continue
        if (item.tokens === null) out[role].unknown += 1
        else out[role].tokens += item.tokens
      }
    }
    return out
  })

  function totalText(role: LoadRole): string {
    const { unknown } = totals[role]
    const name = role === 'brain' ? 'Brain' : 'Workers'
    const extra =
      unknown > 0 ? `, plus ${unknown} ${unknown === 1 ? 'item' : 'items'} of unknown size` : ''
    return `${name}: about ${formatTokens(totals[role].tokens)} tokens per request${extra}`
  }

  const status = $derived(preview ? 'ready' : agentLoad.status)
  const codexState = $derived<CodexGroupState>(preview ? (preview.codex ?? 'ok') : agentLoad.codex)

  const cursorState = $derived<CursorGroupState>(
    preview ? (preview.cursor ?? 'ok') : agentLoad.cursor
  )

  onMount(() => {
    if (preview) return
    void settings.load()
    void agentLoad.load()
  })
</script>

<section aria-labelledby="agent-load-title" class="flex flex-col gap-3" data-agent-load>
  <div class="flex flex-col gap-1">
    <h2
      id="agent-load-title"
      class="font-display text-[22px] font-bold tracking-title text-text-bright uppercase"
    >
      Agent loading
    </h2>
    <p class="text-sm text-text-muted">
      Arc agents load your MCP servers, plugins, skills and hooks just as the terminal does, and
      each one adds to the setup every request carries. Switch off what the brain or the workers
      don't need. Workers also covers conflict resolvers. Nothing changes in the terminal.
    </p>
    <ul class="flex list-disc flex-col gap-0.5 pl-5 text-sm text-text-muted">
      <li>
        Changes apply to agents started afterwards; a resumed agent picks them up on its next start.
      </li>
      <li>
        Switching off a plugin or a skill for Workers removes its commands from Arc's "/" list.
      </li>
      <li>
        Arc's own tools are always loaded. Your ~/.claude/agents are not loaded by Arc agents, and
        your ~/.claude/commands are always loaded.
      </li>
      <li>
        Sizes are estimates of the names and descriptions Claude lists, not of what a hook prints.
      </li>
    </ul>
  </div>
  <div
    class="flex flex-wrap gap-x-6 gap-y-1 rounded-hud border border-border px-4 py-2 text-sm text-text"
    role="status"
  >
    {#each ['brain', 'workers'] as const as role (role)}
      <span data-load-total={role} title="{exactTokens(totals[role].tokens)} tokens"
        >{totalText(role)}</span
      >
    {/each}
  </div>
  {#if status === 'loading'}
    <p class="py-4 text-sm tracking-label text-text-muted" role="status">Loading…</p>
  {:else if status === 'error'}
    <ErrorText message="Couldn't list what agents load." />
  {:else}
    {#each GROUPS as group (group.kind)}
      {@const rows = items.filter((i) => i.kind === group.kind)}
      {#if rows.length > 0 || group.kind === 'codex-mcp' || group.kind === 'cursor-mcp'}
        <div class="flex flex-col gap-1" data-load-group={group.kind}>
          <div class="flex items-end justify-between gap-3">
            <h3 class="text-base font-semibold text-text-bright">{group.title}</h3>
            <p
              class="flex gap-4 pr-2 text-xs tracking-label text-text-muted uppercase"
              aria-hidden="true"
            >
              <span class="w-11 text-center">Brain</span>
              <span class="w-11 text-center">Workers</span>
            </p>
          </div>
          {#if rows.length > 0}
            <ul aria-label={group.title} class="rounded-hud border border-border">
              {#each rows as item (item.key)}
                <LoadRow
                  {item}
                  brainOn={isOn(item.key, 'brain')}
                  workersOn={isOn(item.key, 'workers')}
                  onset={(role, on) => {
                    if (!preview) void agentLoad.set(item.key, role, on)
                  }}
                />
              {/each}
            </ul>
          {:else if group.kind === 'cursor-mcp'}
            {#if cursorState === 'loading'}
              <p class="py-4 text-sm tracking-label text-text-muted" role="status">
                Loading Cursor servers…
              </p>
            {:else if cursorState === 'unavailable'}
              <EmptyState text="Cursor isn't set up, so its servers can't be listed." icon="info" />
            {:else if cursorState === 'unreadable'}
              <EmptyState text="Arc couldn't read your Cursor servers." icon="info" />
            {:else}
              <EmptyState text="No Cursor MCP servers" icon="info" />
            {/if}
          {:else if codexState === 'loading'}
            <p class="py-4 text-sm tracking-label text-text-muted" role="status">
              Loading Codex servers…
            </p>
          {:else if codexState === 'unavailable'}
            <EmptyState text="Codex isn't set up, so its servers can't be listed." icon="info" />
          {:else if codexState === 'unreadable'}
            <EmptyState text="Arc couldn't read your Codex servers." icon="info" />
          {:else}
            <EmptyState text="No Codex MCP servers" icon="info" />
          {/if}
        </div>
      {/if}
    {/each}
    {#if items.filter((i) => i.kind !== 'codex-mcp' && i.kind !== 'cursor-mcp').length === 0}
      <EmptyState
        text="Nothing to switch off: no MCP servers, plugins, skills or hooks found"
        icon="folder"
      />
    {/if}
  {/if}
</section>
