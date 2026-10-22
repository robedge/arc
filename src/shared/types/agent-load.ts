/**
 * What Arc agents load (spec 009). The user switches items off per role; only what is off is stored.
 * `brain` is the brain; `workers` is workers and conflict resolvers.
 */

export const LOAD_ROLES = ['brain', 'workers'] as const
export type LoadRole = (typeof LOAD_ROLES)[number]

/** The item keys switched off, per role (`app_settings` key `agents.loadOff`). A key with no matching item is harmless. */
export interface AgentLoadOff {
  brain: string[]
  workers: string[]
}

export const EMPTY_LOAD_OFF: AgentLoadOff = { brain: [], workers: [] }

export type LoadKind = 'mcp' | 'plugin' | 'skill' | 'hook' | 'codex-mcp' | 'cursor-mcp'

/** The keys of the items, shared by main (filtering) and the renderer (switches). */
export const loadKey = {
  mcp: (name: string): string => `mcp:${name}`,
  plugin: (id: string): string => `plugin:${id}`,
  skill: (folder: string): string => `skill:${folder}`,
  hook: (event: string): string => `hook:${event}`,
  codexMcp: (name: string): string => `codex-mcp:${name}`,
  cursorMcp: (name: string): string => `cursor-mcp:${name}`
} as const

export interface LoadItem {
  key: string
  kind: LoadKind
  label: string
  /** Where it comes from: "Your servers", "Plugin alpha", ".mcp.json in api". */
  detail?: string
  /** About this many tokens per request (`ceil(chars / 4)`); null when Arc cannot work it out. */
  tokens: number | null
  /** Why a number is partial or missing, shown next to it. */
  note?: string
}

/** Whether the Codex servers could be listed. */
export type CodexLoadState = 'ok' | 'unavailable' | 'unreadable'

/** Whether the Cursor servers could be listed. */
export type CursorLoadState = 'ok' | 'unavailable' | 'unreadable'

/** What Claude agents can load (`agent-load:get`); read from files, so it answers quickly. */
export interface LoadCatalogueData {
  items: LoadItem[]
}

/** The user's Codex servers (`agent-load:codex`); Codex has to start to list them, so it is asked separately. */
export interface CodexLoadData {
  items: LoadItem[]
  state: CodexLoadState
}

/** The user's Cursor servers (`agent-load:cursor`); read from `~/.cursor/mcp.json` and the projects' `.cursor/mcp.json`, and only while Cursor is usable. */
export interface CursorLoadData {
  items: LoadItem[]
  state: CursorLoadState
}

/** The estimate rule of spec 008's setup estimator: characters divided by 4, rounded up. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}
