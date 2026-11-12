import {
  EMPTY_LOAD_OFF,
  type AgentLoadOff,
  type CodexLoadState,
  type CursorLoadState,
  type LoadItem,
  type LoadRole
} from '@shared/types/agent-load'
import { settings } from './settings.svelte'

export type AgentLoadStatus = 'loading' | 'ready' | 'error'
/** The Codex group loads on its own: Codex has to start to list its servers. */
export type CodexGroupState = 'loading' | CodexLoadState
/** The Cursor group loads on its own too: it is read from files, but only while Cursor is usable. */
export type CursorGroupState = 'loading' | CursorLoadState

/** One column's total: the sizes of the items that are on, and how many of them have no size. */
export interface LoadTotal {
  tokens: number
  unknown: number
}

/**
 * What Arc agents can load and what the user switched off per role (spec 009). The switches live in
 * the `agents.loadOff` setting (main is the source of truth); the item list comes from `agent-load:get`.
 */
class AgentLoadStore {
  status = $state<AgentLoadStatus>('loading')
  /** Claude's items (MCP servers, plugins, skills, hooks) and, once Codex answered, its servers. */
  claudeItems = $state<LoadItem[]>([])
  codexItems = $state<LoadItem[]>([])
  codex = $state<CodexGroupState>('loading')
  cursorItems = $state<LoadItem[]>([])
  cursor = $state<CursorGroupState>('loading')
  private generation = 0

  get items(): LoadItem[] {
    return [...this.claudeItems, ...this.codexItems, ...this.cursorItems]
  }

  /** The stored selection; nothing is off until the settings have loaded. */
  get off(): AgentLoadOff {
    return settings.values?.['agents.loadOff'] ?? EMPTY_LOAD_OFF
  }

  isOn(key: string, role: LoadRole): boolean {
    return !this.off[role].includes(key)
  }

  total(role: LoadRole): LoadTotal {
    let tokens = 0
    let unknown = 0
    for (const item of this.items) {
      if (!this.isOn(item.key, role)) continue
      if (item.tokens === null) unknown += 1
      else tokens += item.tokens
    }
    return { tokens, unknown }
  }

  /** Switches one item on or off for one role. Only the off keys are stored, so switching on removes the key. */
  async set(key: string, role: LoadRole, on: boolean): Promise<void> {
    // Plain arrays: the stored value is reactive state, and a proxy cannot cross the IPC boundary.
    const current: AgentLoadOff = {
      brain: [...this.off.brain],
      workers: [...this.off.workers]
    }
    const rest = current[role].filter((k) => k !== key)
    const next: AgentLoadOff = { ...current, [role]: on ? rest : [...rest, key] }
    const before = settings.values
    // Optimistic: the switch and the totals move at once; a failed save puts the old selection back.
    if (before) settings.apply({ ...before, 'agents.loadOff': next })
    await settings.save({ 'agents.loadOff': next })
    if (settings.error !== null && before) settings.apply(before)
  }

  async load(): Promise<void> {
    const generation = ++this.generation
    if (this.status !== 'ready') this.status = 'loading'
    this.codex = 'loading'
    this.cursor = 'loading'
    // Codex is asked at the same time but shown when it answers, so a slow start never holds the page back.
    const codexAsk = this.loadCodex(generation)
    const cursorAsk = this.loadCursor(generation)
    const result = await window.arc.invoke('agent-load:get', {})
    if (generation === this.generation) {
      this.claudeItems = result.ok ? result.data.items : []
      this.status = result.ok ? 'ready' : 'error'
    }
    await Promise.all([codexAsk, cursorAsk])
  }

  private async loadCodex(generation: number): Promise<void> {
    const result = await window.arc.invoke('agent-load:codex', {})
    if (generation !== this.generation) return
    // On failure the group says Arc couldn't read the servers.
    this.codexItems = result.ok ? result.data.items : []
    this.codex = result.ok ? result.data.state : 'unreadable'
  }

  private async loadCursor(generation: number): Promise<void> {
    const result = await window.arc.invoke('agent-load:cursor', {})
    if (generation !== this.generation) return
    this.cursorItems = result.ok ? result.data.items : []
    this.cursor = result.ok ? result.data.state : 'unreadable'
  }

  reset(): void {
    this.generation++
    this.status = 'loading'
    this.claudeItems = []
    this.codexItems = []
    this.codex = 'loading'
    this.cursorItems = []
    this.cursor = 'loading'
  }
}

export const agentLoad = new AgentLoadStore()
