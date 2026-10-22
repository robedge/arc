/** One installed plugin as the Settings page lists it (spec 005, tech spec 2.9). */
export interface PluginRow {
  /** `name@marketplace`. */
  id: string
  name: string
  marketplace: string
  version: string
  description: string
  author?: string
  enabled: boolean
  /** Where the marketplace comes from (a repository or folder), for a tooltip. */
  source?: string
  counts: { commands: number; skills: number; agents: number }
  /** The plugin ships MCP servers; Arc does not start them. */
  hasMcp: boolean
  /** The plugin ships hooks; Arc does not run them. */
  hasHooks: boolean
  /** The newer version the marketplace lists (a short sha for sha versions). */
  updateAvailable?: string
}

export type PluginKind = 'install' | 'update' | 'uninstall' | 'check-updates'

/** `plugins:progress`: one change's state. `target` is the plugin (empty for check-updates); `message` is the CLI's own reason on failure. */
export interface PluginProgress {
  opId: string
  kind: PluginKind
  target: string
  state: 'running' | 'done' | 'failed'
  message?: string
}
