import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MCP_SERVER_NAME } from '../bridge/types'
import type { LoadRole } from '../../shared/types/agent-load'
import type { BypassReport } from '../../shared/types/provider'
import type {
  CodexPersonalServer,
  CodexStartOptions,
  CursorStartOptions
} from '../agents/agent-adapter'
import { readCursorMcpServers } from '../agents/cursor/cursor-mcp-config'
import type { PluginViewSource } from '../plugins/plugin-view'
import {
  isRecord,
  readPluginMcpServers,
  readRepoMcpServers,
  readUserHooks,
  readUserMcpServers,
  type ConfigLog,
  type McpServerSpec
} from './claude-user-config'
import { loadKey } from '../../shared/types/agent-load'
import { NOTHING_OFF, type OffFor } from './load-selection'
import type { McpToolCatalogue } from './mcp-tool-catalogue'

/**
 * The user's own and their plugins' MCP servers and hooks for Arc agents (spec 007 section 2.6, tech
 * spec 2.3). Claude keeps `--setting-sources project`, which keeps the user's permission rules, env
 * and other settings out; the hooks come in through a generated hooks-only `--settings` file and the
 * servers through one generated `--mcp-config` (with `--strict-mcp-config`) that merges Arc's bridge,
 * the user's servers, the plugins' and the repositories'. Codex keeps the real `CODEX_HOME`, so its
 * servers load as in the terminal; Arc only learns their names, to ask for approval on every call.
 */

const KEEP_CONFIGS = 64
const NAMES_CACHE_MS = 30_000
const EMPTY_BYPASS: BypassReport = {
  claudeHookEvents: [],
  codexAllowPrefixes: [],
  codexRulesCovered: 0
}
const HOOKS_FILE = 'hooks.settings.json'
const MCP_FILE = 'mcp.json'

/** The files one Claude agent is started with. */
export interface ClaudePersonalFiles {
  /** `--mcp-config`: the merged file (mode 0600; it holds the bridge token and the user's secrets). */
  mcpConfigPath: string
  /** `--settings`: a file with only `hooks`; undefined when the user has no hooks. */
  hooksSettingsPath?: string
}

export interface ClaudePersonalRequest {
  /** The repositories the agent works in (their `.mcp.json` and local-scope servers load). */
  repoPaths: readonly string[]
  /** The bridge's per-agent `--mcp-config` file; its servers (`arc`) win name clashes. Left out for a probe. */
  arcConfigPath?: string
  /**
   * Whose selection applies (spec 009): `brain` for the brain, `workers` for workers, conflict resolvers
   * and the command probe. Left out, nothing is filtered.
   */
  role?: LoadRole
}

/** The user's Codex MCP servers for one folder, as far as Arc needs them. */
export interface CodexPersonalMcp {
  /** The servers that run: Arc puts each into `prompt` mode. */
  servers: CodexPersonalServer[]
  /** Names of servers the user switched off for the role (spec 009); they are disabled on the thread. */
  disabled?: string[]
  /**
   * True when the server list could not be read, even after one retry. Arc then cannot put those
   * servers into `prompt` mode, so it asks about every personal tool call Codex raises (the
   * approval handler treats a server it did not cover as "ask").
   */
  degraded: boolean
}

/** The user's Cursor MCP servers for one folder and role (names only, never their settings). */
export interface CursorPersonalMcp {
  /** Every server the mcp.json files define for this folder. */
  servers: string[]
  /** Servers the user switched off for the role; each is replaced by a no-op session entry and denied. */
  off: string[]
  /** True when an mcp.json file could not be read; every switched-off key is then treated as a server. */
  degraded: boolean
}

/** What the launch code asks for; `PersonalConfigService` is the real one. */
export interface PersonalLaunchConfig {
  claude(request: ClaudePersonalRequest): Promise<ClaudePersonalFiles>
  /**
   * The user's Codex MCP servers that apply in this folder (names and tool names only, never their
   * settings). With a role, the servers that role switched off move to `disabled`.
   */
  codexMcp(cwd: string, role?: LoadRole): Promise<CodexPersonalMcp>
  /** The user's Cursor MCP servers for this folder, with the ones the role switched off. */
  cursorMcp?(cwd: string, role: LoadRole): Promise<CursorPersonalMcp>
  /** Decides whether a tool of a personal MCP server only reads; fed by the running agents. */
  readonly mcp?: McpToolCatalogue | undefined
  /** The user's hooks and Codex rules that can skip Arc's approvals (Settings and the event log). */
  bypass?(repoPaths: readonly string[]): Promise<BypassReport>
}

/**
 * Puts the user's Codex servers into the thread options and returns the names that are covered, that
 * is, the servers whose every tool call will reach Arc as an approval request.
 */
export function applyCodexMcp(codex: CodexStartOptions, mcp: CodexPersonalMcp): Set<string> {
  const names = mcp.servers.map((server) => server.name)
  if (names.length > 0) codex.personalMcpServers = names
  if (mcp.disabled && mcp.disabled.length > 0) codex.disabledMcpServers = mcp.disabled
  const tools = Object.fromEntries(
    mcp.servers.filter((s) => s.approvalTools.length > 0).map((s) => [s.name, s.approvalTools])
  )
  if (Object.keys(tools).length > 0) codex.personalMcpApprovalTools = tools
  return new Set(names)
}

/** Puts the switched-off Cursor servers into the start options; `buildSessionParams` turns them into session entries. */
export function applyCursorMcp(cursor: CursorStartOptions, mcp: CursorPersonalMcp): string[] {
  const off = mcp.off.filter((name) => name !== MCP_SERVER_NAME)
  if (off.length > 0) cursor.offMcpServers = off
  return off
}

export interface PersonalConfigDeps {
  /** `userData/agent-config`. */
  baseDir: string
  /** The plugins of the view (the same selection `--plugin-dir` gets for that role). */
  plugins: {
    sources: (repoPaths: readonly string[], role?: LoadRole) => Promise<PluginViewSource[]>
  }
  /** What the user switched off per role; left out, everything is on. */
  off?: OffFor
  /** The servers of the user's Codex configuration, values dropped (`CodexProbe.listMcpServers`). */
  codexServers?: (cwd: string) => Promise<CodexPersonalServer[]>
  /** Decides read-only tools of personal MCP servers; handed to the launch code as `mcp`. */
  mcp?: McpToolCatalogue
  /** Reads the hooks and Codex rules that can skip Arc's approvals; handed to the launch code as `bypass`. */
  bypass?: (repoPaths: readonly string[]) => Promise<BypassReport>
  /** Read per build so tests can fake it (default: the process HOME). */
  getHome?: () => string
  log?: ConfigLog
  /** Config folders to keep besides the current one. */
  keep?: number
  now?: () => number
}

/** Merges server sets; a later set wins a name clash. */
function mergeServers(
  ...sets: readonly Record<string, McpServerSpec>[]
): Record<string, McpServerSpec> {
  return Object.assign({}, ...sets) as Record<string, McpServerSpec>
}

/** The hooks without the events the user switched off; undefined when none is left. */
function withoutOffHooks(
  hooks: Record<string, unknown> | undefined,
  off: ReadonlySet<string>
): Record<string, unknown> | undefined {
  if (!hooks) return undefined
  const kept = Object.fromEntries(
    Object.entries(hooks).filter(([event]) => !off.has(loadKey.hook(event)))
  )
  return Object.keys(kept).length > 0 ? kept : undefined
}

/** The merged servers without the ones switched off; Arc's own server is never removed. */
function withoutOffServers(
  servers: Record<string, McpServerSpec>,
  off: ReadonlySet<string>
): Record<string, McpServerSpec> {
  return Object.fromEntries(
    Object.entries(servers).filter(
      ([name]) => name === MCP_SERVER_NAME || !off.has(loadKey.mcp(name))
    )
  )
}

export class PersonalConfigService implements PersonalLaunchConfig {
  private readonly keep: number
  private readonly log: ConfigLog
  private readonly now: () => number
  private readonly servers = new Map<string, { at: number; servers: CodexPersonalServer[] }>()
  private swept = false

  constructor(private readonly deps: PersonalConfigDeps) {
    this.keep = deps.keep ?? KEEP_CONFIGS
    this.log = deps.log ?? { warn: () => undefined }
    this.now = deps.now ?? Date.now
  }

  /**
   * Resolves and writes the Claude files for one agent start. Recomputed every time, so a changed
   * `~/.claude.json` or plugin shows up in the next agent. Rejects when the bridge's own config
   * cannot be read; the caller then starts with the bridge file alone.
   */
  async claude(request: ClaudePersonalRequest): Promise<ClaudePersonalFiles> {
    const home = (this.deps.getHome ?? homedir)()
    const off = request.role ? this.off(request.role) : new Set<string>()
    const hooks = withoutOffHooks(await readUserHooks(home), off)
    const servers = withoutOffServers(await this.mcpServers(home, request), off)
    const hooksJson = hooks ? JSON.stringify({ hooks }) : undefined
    const mcpJson = JSON.stringify({ mcpServers: servers })
    const hash = createHash('sha1')
      .update(JSON.stringify({ hooks: hooksJson ?? null, mcp: mcpJson }))
      .digest('hex')
    const dir = await this.write(hash, hooksJson, mcpJson)
    return {
      mcpConfigPath: join(dir, MCP_FILE),
      ...(hooksJson ? { hooksSettingsPath: join(dir, HOOKS_FILE) } : {})
    }
  }

  private off(role: LoadRole): ReadonlySet<string> {
    return (this.deps.off ?? NOTHING_OFF)(role)
  }

  get mcp(): McpToolCatalogue | undefined {
    return this.deps.mcp
  }

  bypass(repoPaths: readonly string[]): Promise<BypassReport> {
    return this.deps.bypass?.(repoPaths) ?? Promise.resolve(EMPTY_BYPASS)
  }

  /**
   * The user's Codex MCP servers for this folder, held in memory for a short while. A failed read
   * is tried once more. When that fails too, the answer is `degraded` (and is not cached, so the
   * next agent tries again): the agent still starts, and the approval handler asks about every call
   * Codex raises for a server Arc could not name (fail closed).
   */
  async codexMcp(cwd: string, role?: LoadRole): Promise<CodexPersonalMcp> {
    const all = await this.readCodexServers(cwd)
    if (all.degraded || !role) return all
    const off = this.off(role)
    const disabled = all.servers.filter((s) => off.has(loadKey.codexMcp(s.name))).map((s) => s.name)
    if (disabled.length === 0) return all
    return {
      servers: all.servers.filter((s) => !disabled.includes(s.name)),
      disabled,
      degraded: false
    }
  }

  /**
   * The user's Cursor MCP servers for this folder (the home and the folder's `mcp.json`, read-only)
   * and the ones the role switched off. When a file cannot be read the names are unknown, so every
   * stored `cursor-mcp:` key of the role counts as a server: it fails closed rather than loading it.
   */
  async cursorMcp(cwd: string, role: LoadRole): Promise<CursorPersonalMcp> {
    const home = (this.deps.getHome ?? homedir)()
    const prefix = loadKey.cursorMcp('')
    const stored = [...this.off(role)]
      .filter((k) => k.startsWith(prefix))
      .map((k) => k.slice(prefix.length))
    let read: Awaited<ReturnType<typeof readCursorMcpServers>> | undefined
    try {
      read = await readCursorMcpServers(home, [cwd])
    } catch (error: unknown) {
      this.log.warn('could not read the Cursor MCP servers', error)
    }
    if (read === undefined || read.unreadable) {
      return { servers: read?.servers.map((s) => s.name) ?? [], off: stored, degraded: true }
    }
    const servers = read.servers.map((s) => s.name)
    return { servers, off: servers.filter((name) => stored.includes(name)), degraded: false }
  }

  private async readCodexServers(cwd: string): Promise<CodexPersonalMcp> {
    const read = this.deps.codexServers
    if (!read) return { servers: [], degraded: false }
    const cached = this.servers.get(cwd)
    if (cached && this.now() - cached.at < NAMES_CACHE_MS) {
      return { servers: cached.servers, degraded: false }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const servers = (await read(cwd)).filter((server) => server.name !== MCP_SERVER_NAME)
        this.servers.set(cwd, { at: this.now(), servers })
        return { servers, degraded: false }
      } catch (error: unknown) {
        this.log.warn(
          attempt === 0
            ? 'could not read the Codex MCP servers; trying once more'
            : 'could not read the Codex MCP servers; personal tools will ask before every call',
          error
        )
      }
    }
    return { servers: [], degraded: true }
  }

  /** plugins < user < repository `.mcp.json` < local scope < the bridge (`arc` always wins). */
  private async mcpServers(
    home: string,
    request: ClaudePersonalRequest
  ): Promise<Record<string, McpServerSpec>> {
    const plugins: Record<string, McpServerSpec>[] = []
    for (const plugin of await this.deps.plugins.sources(request.repoPaths, request.role)) {
      plugins.push(await readPluginMcpServers(plugin, this.log))
    }
    const user = await readUserMcpServers(home, request.repoPaths)
    // With several repositories the first one to define a name keeps it.
    const repos: Record<string, McpServerSpec>[] = []
    const local: Record<string, McpServerSpec>[] = []
    for (const repo of request.repoPaths) {
      repos.unshift(await readRepoMcpServers(repo))
      const own = user.local.get(repo)
      if (own) local.unshift(own)
    }
    const arc = request.arcConfigPath ? await this.readArcServers(request.arcConfigPath) : {}
    return mergeServers(...plugins, user.user, ...repos, ...local, arc)
  }

  private async readArcServers(path: string): Promise<Record<string, McpServerSpec>> {
    const file: unknown = JSON.parse(await readFile(path, 'utf8'))
    const servers = isRecord(file) ? file['mcpServers'] : undefined
    if (!isRecord(servers) || !isRecord(servers[MCP_SERVER_NAME])) {
      throw new Error('the bridge config has no arc server')
    }
    return Object.fromEntries(
      Object.entries(servers).filter((entry): entry is [string, McpServerSpec] =>
        isRecord(entry[1])
      )
    )
  }

  /** Writes `<baseDir>/<hash>/` (mode 0700, files 0600) unless it exists; prunes the old ones. */
  private async write(
    hash: string,
    hooksJson: string | undefined,
    mcpJson: string
  ): Promise<string> {
    const { baseDir } = this.deps
    await mkdir(baseDir, { recursive: true, mode: 0o700 })
    if (!this.swept) {
      this.swept = true
      for (const entry of await readdir(baseDir).catch(() => [] as string[])) {
        if (entry.startsWith('.tmp-'))
          await rm(join(baseDir, entry), { recursive: true, force: true })
      }
    }
    const target = join(baseDir, hash)
    if (
      await stat(target).then(
        () => true,
        () => false
      )
    ) {
      const when = new Date(this.now())
      await utimes(target, when, when).catch(() => undefined)
    } else {
      const tmp = join(baseDir, `.tmp-${randomBytes(6).toString('hex')}`)
      try {
        await mkdir(tmp, { mode: 0o700 })
        await writeFile(join(tmp, MCP_FILE), mcpJson, { mode: 0o600 })
        if (hooksJson) await writeFile(join(tmp, HOOKS_FILE), hooksJson, { mode: 0o600 })
        try {
          await rename(tmp, target)
        } catch (error: unknown) {
          // Another start produced the same files first: keep that one.
          if (
            !(await stat(target).then(
              () => true,
              () => false
            ))
          )
            throw error
          await rm(tmp, { recursive: true, force: true })
        }
      } catch (error: unknown) {
        await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
        throw error
      }
    }
    await this.prune(hash)
    return target
  }

  /** Keeps the newest folders (the current one always) and removes the rest. */
  private async prune(currentHash: string): Promise<void> {
    const { baseDir } = this.deps
    const dirs: { name: string; mtime: number }[] = []
    for (const entry of await readdir(baseDir)) {
      if (entry.startsWith('.')) continue
      try {
        dirs.push({ name: entry, mtime: (await stat(join(baseDir, entry))).mtimeMs })
      } catch {
        // Gone already.
      }
    }
    dirs.sort((a, b) => b.mtime - a.mtime)
    const others = dirs.map((d) => d.name).filter((n) => n !== currentHash)
    const keepNames = new Set([currentHash, ...others].slice(0, this.keep))
    for (const dir of dirs) {
      if (!keepNames.has(dir.name)) {
        await rm(join(baseDir, dir.name), { recursive: true, force: true })
      }
    }
  }
}
