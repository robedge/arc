import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { PluginViewSource } from '../plugins/plugin-view'

/**
 * Read-only readers for the Claude Code configuration Arc agents load (spec 007 section 2.6): the
 * user's hooks, the MCP servers of the user, of their plugins and of a repository. Nothing here
 * writes to `~/.claude`, `~/.claude.json` or a repository, and nothing logs a value: server entries
 * carry tokens, so callers only ever see (and log) names.
 */

/** One MCP server entry exactly as the user wrote it (`command`/`args`/`env`, or `type`/`url`/`headers`). */
export type McpServerSpec = Record<string, unknown>

export interface ConfigLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** Only the entries that are objects: a broken entry is left out instead of failing the agent's start. */
function serversOf(value: unknown): Record<string, McpServerSpec> {
  if (!isRecord(value)) return {}
  const out: Record<string, McpServerSpec> = {}
  for (const [name, spec] of Object.entries(value)) {
    if (isRecord(spec)) out[name] = spec
  }
  return out
}

/** `~/.claude/settings.json`: the `hooks` object and nothing else (never `permissions`, `env` or any other key). */
export async function readUserHooks(home: string): Promise<Record<string, unknown> | undefined> {
  const settings = await readJson(join(home, '.claude', 'settings.json'))
  if (!isRecord(settings)) return undefined
  const hooks = settings['hooks']
  return isRecord(hooks) && Object.keys(hooks).length > 0 ? hooks : undefined
}

/** The event names of a hooks object that have at least one hook. */
export function hookEventsOf(hooks: unknown): string[] {
  if (!isRecord(hooks)) return []
  return Object.entries(hooks)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : isRecord(value)))
    .map(([event]) => event)
}

export interface UserMcpServers {
  /** `mcpServers` at the top of `~/.claude.json` (user scope). */
  user: Record<string, McpServerSpec>
  /** `projects[<repo>].mcpServers` (local scope), by repository path. */
  local: Map<string, Record<string, McpServerSpec>>
}

/** `~/.claude.json`: user-scope servers and the local-scope servers of the given repositories. */
export async function readUserMcpServers(
  home: string,
  repoPaths: readonly string[]
): Promise<UserMcpServers> {
  const file = await readJson(join(home, '.claude.json'))
  const result: UserMcpServers = { user: {}, local: new Map() }
  if (!isRecord(file)) return result
  result.user = serversOf(file['mcpServers'])
  const projects = file['projects']
  if (isRecord(projects)) {
    for (const repo of repoPaths) {
      const entry = projects[repo]
      if (!isRecord(entry)) continue
      const servers = serversOf(entry['mcpServers'])
      if (Object.keys(servers).length > 0) result.local.set(repo, servers)
    }
  }
  return result
}

/** A repository's `.mcp.json`. Both `{ mcpServers: {...} }` and a bare `{ name: {...} }` are accepted. */
export async function readRepoMcpServers(repoPath: string): Promise<Record<string, McpServerSpec>> {
  return serversFromMcpFile(await readJson(join(repoPath, '.mcp.json')))
}

function serversFromMcpFile(file: unknown): Record<string, McpServerSpec> {
  if (!isRecord(file)) return {}
  return serversOf(isRecord(file['mcpServers']) ? file['mcpServers'] : file)
}

/** Names the CLI would give the tools of a plugin server are made of these characters only. */
function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** The name a plugin's server gets in the merged config, the way Claude spells its tools (`plugin_<plugin>_<server>`). */
export function pluginServerName(plugin: string, server: string): string {
  return `plugin_${safeName(plugin)}_${safeName(server)}`
}

/** Replaces `${CLAUDE_PLUGIN_ROOT}` in every string of the entry; `undefined` when it uses a `${user_config.*}` value. */
function expandPluginVars(value: unknown, root: string): { value: unknown; unresolved: boolean } {
  let unresolved = false
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.includes('${user_config.')) unresolved = true
      return node.replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    }
    if (Array.isArray(node)) return node.map(walk)
    if (isRecord(node)) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]))
    }
    return node
  }
  const expanded = walk(value)
  return { value: expanded, unresolved }
}

/**
 * Where a plugin keeps MCP servers: `.mcp.json` at its root and the `mcpServers` key of
 * `plugin.json` (inline, or a path / list of paths to files in the plugin).
 */
async function pluginServerSets(
  plugin: PluginViewSource
): Promise<Record<string, McpServerSpec>[]> {
  const sets = [serversFromMcpFile(await readJson(join(plugin.installPath, '.mcp.json')))]
  const declared = plugin.manifest['mcpServers']
  const paths = typeof declared === 'string' ? [declared] : Array.isArray(declared) ? declared : []
  if (isRecord(declared)) sets.push(serversOf(declared))
  for (const path of paths) {
    if (typeof path !== 'string') continue
    const file = isAbsolute(path) ? path : resolve(plugin.installPath, path)
    sets.push(serversFromMcpFile(await readJson(file)))
  }
  return sets
}

/**
 * The MCP servers of one plugin, namespaced `plugin_<plugin>_<server>` with `${CLAUDE_PLUGIN_ROOT}`
 * expanded to the plugin's install folder. A server that needs a `${user_config.*}` value cannot be
 * resolved by Arc, so it is skipped with a log line that names it (never its contents).
 */
export async function readPluginMcpServers(
  plugin: PluginViewSource,
  log?: ConfigLog
): Promise<Record<string, McpServerSpec>> {
  const out: Record<string, McpServerSpec> = {}
  for (const set of await pluginServerSets(plugin)) {
    for (const [name, spec] of Object.entries(set)) {
      const { value, unresolved } = expandPluginVars(spec, plugin.installPath)
      if (unresolved) {
        log?.warn(
          `plugin ${plugin.id}: MCP server "${name}" needs a user_config value; left out of the agent's MCP config`
        )
        continue
      }
      if (isRecord(value)) out[pluginServerName(plugin.folder, name)] = value
    }
  }
  return out
}
