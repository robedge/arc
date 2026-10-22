import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { CodexPersonalServer } from '../agents/agent-adapter'
import { readCursorMcpServers } from '../agents/cursor/cursor-mcp-config'
import type { PluginViewSource } from '../plugins/plugin-view'
import {
  hookEventsOf,
  readPluginMcpServers,
  readRepoMcpServers,
  readUserHooks,
  readUserMcpServers,
  type ConfigLog
} from './claude-user-config'
import {
  describeMarkdown,
  listingEntry,
  listingTokens,
  markdownFiles,
  skillFolders
} from './load-listing'
import { claudeMcpSafeName } from './mcp-tool-catalogue'
import {
  loadKey,
  type CodexLoadData,
  type CodexLoadState,
  type CursorLoadData,
  type LoadCatalogueData,
  type LoadItem
} from '../../shared/types/agent-load'

/**
 * The items Settings > Agent loading lists (spec 009 tech spec 2.6): what Arc already reads of the
 * user's setup, with a size estimate per item where one can be worked out. Read-only, and only names
 * and front matter ever leave the files: no server entry, hook command or token is copied.
 */

const HOOK_NOTE = "What a hook adds (for example a SessionStart hook's text) can't be estimated"
const NAMES_ONLY_NOTE = 'Tool names only'
const PLUGIN_HOOK_NOTE = "Its hooks' output is not counted"

export interface LoadCatalogueDeps {
  /** Read per call so tests can fake it (default: the process HOME). */
  getHome?: () => string
  /** Every project folder Arc knows (their `.mcp.json` and local-scope servers are listed). */
  projectPaths: () => string[]
  /** All installed, enabled plugins, whatever the selection says (`PluginViewService.sources` without a role). */
  plugins: { sources: (repoPaths: readonly string[]) => Promise<PluginViewSource[]> }
  /** The user's Codex servers; `ready` is false while Codex is not usable. */
  codex: {
    ready: () => boolean | Promise<boolean>
    servers: (cwd: string) => Promise<{ servers: CodexPersonalServer[]; degraded: boolean }>
  }
  /** The user's Cursor servers are listed only while Cursor is usable (`ready`); left out, they are never listed. */
  cursor?: { ready: () => boolean | Promise<boolean> }
  /** Tool names agents reported in this run, by server name (`McpToolCatalogue.knownTools`). */
  knownTools?: () => ReadonlyMap<string, readonly string[]>
  log?: ConfigLog
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

export class LoadCatalogue {
  constructor(private readonly deps: LoadCatalogueDeps) {}

  /** Everything Claude agents load: MCP servers, plugins, skills and hook events. Read from files only. */
  async list(): Promise<LoadCatalogueData> {
    const home = (this.deps.getHome ?? homedir)()
    const projects = this.deps.projectPaths()
    const plugins = await this.deps.plugins.sources(projects).catch((error: unknown) => {
      this.deps.log?.warn('could not list the plugins for Agent loading', error)
      return [] as PluginViewSource[]
    })
    return {
      items: [
        ...(await this.mcpItems(home, projects, plugins)),
        ...(await this.pluginItems(plugins)),
        ...(await this.skillItems(home)),
        ...(await this.hookItems(home))
      ]
    }
  }

  /** The user's Codex servers; this starts Codex's app-server, so it can take a while. */
  async listCodex(): Promise<CodexLoadData> {
    const home = (this.deps.getHome ?? homedir)()
    const { items, state } = await this.codexItems(home)
    return { items, state }
  }

  /** The user's Cursor servers, parsed read-only from the mcp.json files; "unavailable" while Cursor is not ok. */
  async listCursor(): Promise<CursorLoadData> {
    const home = (this.deps.getHome ?? homedir)()
    try {
      if (!this.deps.cursor || !(await this.deps.cursor.ready())) {
        return { items: [], state: 'unavailable' }
      }
      const known = this.deps.knownTools?.() ?? new Map<string, readonly string[]>()
      const { servers, unreadable } = await readCursorMcpServers(home, this.deps.projectPaths())
      // A broken file hides servers Arc cannot name, so the group says so instead of showing part of the list.
      if (unreadable) return { items: [], state: 'unreadable' }
      return {
        state: 'ok',
        items: servers.map((server): LoadItem => {
          const tools = known.get(server.name)
          const sized = tools !== undefined && tools.length > 0
          return {
            key: loadKey.cursorMcp(server.name),
            kind: 'cursor-mcp',
            label: server.name,
            detail: server.source,
            tokens: sized ? listingTokens(tools.map((t) => `${server.name}-${t}`)) : null,
            ...(sized ? { note: NAMES_ONLY_NOTE } : {})
          }
        })
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not list the Cursor servers for Agent loading', error)
      return { items: [], state: 'unreadable' }
    }
  }

  private async mcpItems(
    home: string,
    projects: readonly string[],
    plugins: readonly PluginViewSource[]
  ): Promise<LoadItem[]> {
    const known = this.deps.knownTools?.() ?? new Map<string, readonly string[]>()
    const found = new Map<string, string>()
    const add = (names: Iterable<string>, detail: string): void => {
      for (const name of names) if (!found.has(name)) found.set(name, detail)
    }
    const user = await readUserMcpServers(home, projects)
    add(Object.keys(user.user), 'Your servers')
    for (const repo of projects) {
      add(Object.keys(user.local.get(repo) ?? {}), `Your servers in ${basename(repo)}`)
      add(Object.keys(await readRepoMcpServers(repo)), `.mcp.json in ${basename(repo)}`)
    }
    for (const plugin of plugins) {
      add(Object.keys(await readPluginMcpServers(plugin)), `Plugin ${plugin.folder}`)
    }
    return [...found.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, detail]): LoadItem => {
        const tools = known.get(name)
        const sized = tools !== undefined && tools.length > 0
        return {
          key: loadKey.mcp(name),
          kind: 'mcp',
          label: name,
          detail,
          tokens: sized
            ? listingTokens(tools.map((t) => `mcp__${claudeMcpSafeName(name)}__${t}`))
            : null,
          ...(sized ? { note: NAMES_ONLY_NOTE } : {})
        }
      })
  }

  private async pluginItems(plugins: readonly PluginViewSource[]): Promise<LoadItem[]> {
    const items: LoadItem[] = []
    for (const plugin of plugins) {
      const name =
        typeof plugin.manifest['name'] === 'string' ? plugin.manifest['name'] : plugin.folder
      const entries: string[] = []
      const skillsDir = join(plugin.installPath, 'skills')
      for (const folder of await skillFolders(skillsDir)) {
        const d = await describeMarkdown(join(skillsDir, folder, 'SKILL.md'))
        entries.push(listingEntry(d?.name ?? folder, d?.description))
      }
      const commandsDir = join(plugin.installPath, 'commands')
      for (const rel of await markdownFiles(commandsDir)) {
        const d = await describeMarkdown(join(commandsDir, rel))
        const command = rel.slice(0, -'.md'.length).split('/').join(':')
        entries.push(listingEntry(`${name}:${command}`, d?.description))
      }
      const agentsDir = join(plugin.installPath, 'agents')
      for (const rel of await markdownFiles(agentsDir)) {
        const d = await describeMarkdown(join(agentsDir, rel))
        entries.push(listingEntry(d?.name ?? rel.slice(0, -'.md'.length), d?.description))
      }
      const hasHooks =
        (await fileExists(join(plugin.installPath, 'hooks', 'hooks.json'))) ||
        plugin.manifest['hooks'] !== undefined
      items.push({
        key: loadKey.plugin(plugin.id),
        kind: 'plugin',
        label: name,
        detail: plugin.id,
        tokens: listingTokens(entries),
        ...(hasHooks ? { note: PLUGIN_HOOK_NOTE } : {})
      })
    }
    return items.sort((a, b) => a.label.localeCompare(b.label))
  }

  private async skillItems(home: string): Promise<LoadItem[]> {
    const dir = join(home, '.claude', 'skills')
    const items: LoadItem[] = []
    for (const folder of await skillFolders(dir)) {
      const d = await describeMarkdown(join(dir, folder, 'SKILL.md'))
      items.push({
        key: loadKey.skill(folder),
        kind: 'skill',
        label: d?.name ?? folder,
        detail: '~/.claude/skills',
        tokens: listingTokens([listingEntry(d?.name ?? folder, d?.description)])
      })
    }
    return items
  }

  private async hookItems(home: string): Promise<LoadItem[]> {
    const events = hookEventsOf(await readUserHooks(home)).sort()
    return events.map((event): LoadItem => ({
      key: loadKey.hook(event),
      kind: 'hook',
      label: event,
      detail: '~/.claude/settings.json',
      tokens: null,
      note: HOOK_NOTE
    }))
  }

  private async codexItems(home: string): Promise<{ items: LoadItem[]; state: CodexLoadState }> {
    if (!(await this.deps.codex.ready())) return { items: [], state: 'unavailable' }
    try {
      const { servers, degraded } = await this.deps.codex.servers(home)
      if (degraded) return { items: [], state: 'unreadable' }
      return {
        state: 'ok',
        items: servers
          .map((s) => s.name)
          .sort((a, b) => a.localeCompare(b))
          .map((name): LoadItem => ({
            key: loadKey.codexMcp(name),
            kind: 'codex-mcp',
            label: name,
            detail: 'Your Codex configuration',
            tokens: null
          }))
      }
    } catch (error: unknown) {
      this.deps.log?.warn('could not list the Codex servers for Agent loading', error)
      return { items: [], state: 'unreadable' }
    }
  }
}
