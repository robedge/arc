import type { ProviderId } from '@shared/types/provider'
import { MCP_SERVER_NAME } from '../bridge/types'
import { homedir } from 'node:os'
import type { McpServerTools, McpToolInfo } from '../agents/agent-adapter'
import { readCursorMcpServers, type CursorMcpSpec } from '../agents/cursor/cursor-mcp-config'
import { listCursorServerTools } from '../agents/cursor/cursor-mcp-tools'
import type { NormalizedAction } from '../policy/normalized-action'

/**
 * Whether a tool of one of the user's MCP servers only reads (spec 007 section 2.6, tech spec 2.3).
 * The rule is the same for both providers: a call runs without asking only when the tool says
 * `readOnlyHint: true` and does not say `destructiveHint: true`. Everything else asks: a hint that
 * is false or missing, a tool the server does not list, a server that is down or needs a login.
 *
 * The annotations come from the running agent itself (`AgentHandle.mcpTools`): Claude's
 * `control_request` `mcp_status` and Codex's `mcpServerStatus/list`. Arc therefore holds no second
 * connection to the user's servers, and a server that needs a login Arc cannot give lists nothing,
 * which means "ask".
 */

export type McpReadOnly = 'yes' | 'no' | 'unknown'

/** How long the agent may take to report its servers. */
export const MCP_LIST_TIMEOUT_MS = 10_000
/** How long a report is trusted before the agent is asked again. */
export const MCP_CACHE_MS = 5 * 60_000
/** A failed or timed-out report is not retried for this long, so a hung server cannot stall every call. */
const FAILURE_CACHE_MS = 30_000
/** A tool or server missing from a report older than this is looked up again (a server may have connected since). */
const REFRESH_MISS_MS = 5_000

/** The read-only rule on one listed tool. */
export function isReadOnlyTool(tool: Pick<McpToolInfo, 'readOnly' | 'destructive'>): boolean {
  return tool.readOnly && !tool.destructive
}

/** The characters Claude keeps in the server and tool parts of `mcp__<server>__<tool>`; everything else becomes `_`. */
export function claudeMcpSafeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * Splits a Claude tool name (`mcp__<server>__<tool>`) against the servers the agent runs. Server
 * names can hold `_` (and so `__`), so the name is matched against each known server instead of
 * being split at the first separator; the longest matching server wins. Null when no known server fits.
 */
export function parseClaudeMcpToolName(
  name: string,
  servers: readonly string[]
): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null
  let best: { server: string; tool: string } | null = null
  for (const server of servers) {
    const prefix = `mcp__${claudeMcpSafeName(server)}__`
    if (!name.startsWith(prefix) || name.length === prefix.length) continue
    if (best === null || server.length > best.server.length) {
      best = { server, tool: name.slice(prefix.length) }
    }
  }
  return best
}

/** `mcp__a__b__c` when nothing is known about the servers: the first part is shown as the server. */
function guessClaudeMcpToolName(name: string): { server: string; tool: string } {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match
    ? { server: match[1] ?? name, tool: match[2] ?? name }
    : { server: name.slice('mcp__'.length), tool: '' }
}

/** Reports the running agent's MCP servers; `AgentHandle.mcpTools` bound to the handle. */
export type McpToolSource = () => Promise<McpServerTools[]>

interface Snapshot {
  at: number
  /** Null when the agent could not report. */
  servers: McpServerTools[] | null
}

/** How long Arc trusts its own `tools/list` of a Cursor user server. */
export const CURSOR_TOOLS_CACHE_MS = 60 * 60_000

export interface McpToolCatalogueOptions {
  /** Read per call so tests can fake it (default: the process HOME); where `~/.cursor/mcp.json` is. */
  getHome?: () => string
  /** Lists a Cursor user server's tools (default: Arc's own MCP client, `listCursorServerTools`). */
  listCursorTools?: (
    spec: CursorMcpSpec,
    cwd: string | undefined,
    signal: AbortSignal
  ) => Promise<McpToolInfo[]>
  now?: () => number
  timeoutMs?: number
  cacheMs?: number
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The agent did not list its MCP tools in time.')), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

export class McpToolCatalogue {
  private readonly sources = new Map<string, McpToolSource>()
  private readonly snapshots = new Map<string, Snapshot>()
  private readonly inflight = new Map<string, Promise<Snapshot>>()
  /** The tool names each server reported in this run, by the server's name in the agent's config (spec 009: sizes in Settings). */
  private readonly known = new Map<string, string[]>()
  /** Arc's own `tools/list` of Cursor user servers, by definition; null when the server could not be asked. */
  private readonly cursorTools = new Map<string, { at: number; tools: McpToolInfo[] | null }>()
  private readonly cursorInflight = new Map<string, Promise<McpToolInfo[] | null>>()
  private readonly now: () => number
  private readonly timeoutMs: number
  private readonly cacheMs: number
  private readonly getHome: () => string
  private readonly listCursorTools: NonNullable<McpToolCatalogueOptions['listCursorTools']>

  constructor(options: McpToolCatalogueOptions = {}) {
    this.getHome = options.getHome ?? homedir
    this.listCursorTools = options.listCursorTools ?? listCursorServerTools
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? MCP_LIST_TIMEOUT_MS
    this.cacheMs = options.cacheMs ?? MCP_CACHE_MS
  }

  /** Tool names of the servers any agent has reported so far in this run, by server name. */
  knownTools(): ReadonlyMap<string, readonly string[]> {
    return this.known
  }

  /** The agent's own report of its servers, used for every decision about that agent. */
  attach(agentId: string, source: McpToolSource): void {
    this.sources.set(agentId, source)
    this.snapshots.delete(agentId)
  }

  /**
   * Attaches a running agent's handle (when it can report its servers) and returns the function
   * that detaches it again. Detaching only drops the source it attached, so a restarted agent of
   * the same id keeps its own.
   */
  attachHandle(
    agentId: string,
    handle: { mcpTools?: () => Promise<McpServerTools[]> }
  ): () => void {
    // Read at each call: a handle that cannot report simply fails, and every tool of it asks.
    const source: McpToolSource = () =>
      handle.mcpTools
        ? handle.mcpTools()
        : Promise.reject(new Error('This agent cannot report its MCP servers.'))
    this.attach(agentId, source)
    return () => {
      if (this.sources.get(agentId) !== source) return
      this.sources.delete(agentId)
      this.snapshots.delete(agentId)
      this.inflight.delete(agentId)
    }
  }

  /**
   * A Claude tool call as an action. Null for a tool that is not an MCP tool, and for Arc's own
   * tools, which never need a decision. Any other `mcp__` tool is an `mcp` action: when the agent's
   * report does not name it, it asks (`readOnly: 'unknown'`), so a server Arc cannot see never runs unasked.
   */
  async claudeAction(
    agentId: string,
    tool: string,
    input: Record<string, unknown>
  ): Promise<NormalizedAction | null> {
    if (!tool.startsWith('mcp__') || tool.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return null
    let servers = (await this.snapshot(agentId))?.servers ?? null
    let parsed = servers
      ? parseClaudeMcpToolName(
          tool,
          servers.map((s) => s.name)
        )
      : null
    if (parsed === null || this.toolOf(servers, parsed, 'claude') === undefined) {
      servers = (await this.snapshot(agentId, true))?.servers ?? null
      parsed = servers
        ? parseClaudeMcpToolName(
            tool,
            servers.map((s) => s.name)
          )
        : null
    }
    const found = parsed ?? guessClaudeMcpToolName(tool)
    const listed = parsed === null ? undefined : this.toolOf(servers, parsed, 'claude')
    let readOnly: McpReadOnly = 'unknown'
    if (listed) {
      readOnly = isReadOnlyTool(listed) ? 'yes' : listed.destructive ? 'no' : 'unknown'
    }
    return {
      kind: 'mcp',
      server: found.server,
      tool: found.tool,
      ...(Object.keys(input).length > 0 ? { args: input } : {}),
      readOnly
    }
  }

  /**
   * Settles a Codex tool approval (the elicitation of a `mcp_tool_call`). `action` carries the
   * read-only hint of the `mcpToolCall` item that came just before the request.
   * - A server Arc did not put into `prompt` mode (a plugin's server, or any server when the list
   *   of the user's servers could not be read) always asks: nothing says Arc's rule decided that call.
   * - Otherwise the hint is checked against the thread's tool annotations, for `destructiveHint`
   *   and for a hint the item left out. When they cannot be read the item's own hint stands.
   */
  async codexAction(
    agentId: string,
    action: Extract<NormalizedAction, { kind: 'mcp' }>,
    coveredServers: ReadonlySet<string>
  ): Promise<Extract<NormalizedAction, { kind: 'mcp' }>> {
    if (action.server === MCP_SERVER_NAME) return action
    if (!coveredServers.has(action.server)) return { ...action, readOnly: 'unknown' }
    if (action.readOnly === 'no') return action
    const servers = (await this.snapshot(agentId))?.servers ?? null
    const listed = this.toolOf(servers, { server: action.server, tool: action.tool }, 'codex')
    if (!listed) return action
    if (listed.destructive) return { ...action, readOnly: 'no' }
    if (!listed.readOnly)
      return { ...action, readOnly: action.readOnly === 'yes' ? 'no' : 'unknown' }
    return { ...action, readOnly: 'yes' }
  }

  /**
   * Settles a Cursor MCP tool call (tech spec 2.5). Sources in order:
   * 1. the read-only hint the request itself carried (`action.readOnly` already, set by the normalizer);
   * 2. Arc's own `tools/list` against the user's server definition (stdio or http, 10 s timeout, 1 h cache);
   * 3. otherwise `unknown`, which asks.
   * Arc's own server never needs a decision. `agent mcp list-tools` is not a source: it prints no annotations (spike N8).
   */
  async cursorAction(
    action: Extract<NormalizedAction, { kind: 'mcp' }>,
    cwd?: string
  ): Promise<Extract<NormalizedAction, { kind: 'mcp' }>> {
    if (action.server === MCP_SERVER_NAME || action.readOnly !== 'unknown') return action
    const read = await readCursorMcpServers(this.getHome(), cwd === undefined ? [] : [cwd]).catch(
      () => undefined
    )
    const spec = read?.servers.find((s) => s.name === action.server)?.spec
    if (spec === undefined) return action
    const tools = await this.cursorServerTools(spec, cwd)
    const listed = tools?.find((t) => t.name === action.tool)
    if (listed === undefined) return action
    return {
      ...action,
      readOnly: isReadOnlyTool(listed) ? 'yes' : listed.destructive ? 'no' : 'unknown'
    }
  }

  private cursorServerTools(
    spec: CursorMcpSpec,
    cwd: string | undefined
  ): Promise<McpToolInfo[] | null> {
    const key = JSON.stringify([spec, spec.type === 'stdio' ? (cwd ?? null) : null])
    const cached = this.cursorTools.get(key)
    if (cached) {
      const ttl = cached.tools === null ? FAILURE_CACHE_MS : CURSOR_TOOLS_CACHE_MS
      if (this.now() - cached.at < ttl) return Promise.resolve(cached.tools)
    }
    const running = this.cursorInflight.get(key)
    if (running) return running
    const controller = new AbortController()
    const task = withTimeout(this.listCursorTools(spec, cwd, controller.signal), this.timeoutMs)
      .catch(() => {
        controller.abort()
        return null
      })
      .then((tools) => {
        this.cursorTools.set(key, { at: this.now(), tools })
        this.cursorInflight.delete(key)
        return tools
      })
    this.cursorInflight.set(key, task)
    return task
  }

  private toolOf(
    servers: readonly McpServerTools[] | null,
    at: { server: string; tool: string },
    provider: ProviderId
  ): McpToolInfo | undefined {
    const server = servers?.find((s) => s.name === at.server)
    if (!server?.connected) return undefined
    return server.tools.find(
      (t) => t.name === at.tool || (provider === 'claude' && claudeMcpSafeName(t.name) === at.tool)
    )
  }

  /** The agent's report, cached; `refresh` asks again when the cached one is older than a few seconds or failed. */
  private async snapshot(agentId: string, refresh = false): Promise<Snapshot | null> {
    const source = this.sources.get(agentId)
    if (!source) return null
    const cached = this.snapshots.get(agentId)
    if (cached) {
      const age = this.now() - cached.at
      const failed = cached.servers === null
      const fresh = age < (failed ? FAILURE_CACHE_MS : this.cacheMs)
      if (fresh && !(refresh && !failed && age >= REFRESH_MISS_MS)) return cached
    }
    const running = this.inflight.get(agentId)
    if (running) return running
    const task = (async (): Promise<Snapshot> => {
      try {
        const servers = await withTimeout(source(), this.timeoutMs)
        for (const server of servers) {
          if (server.connected && server.tools.length > 0) {
            this.known.set(
              server.name,
              server.tools.map((t) => t.name)
            )
          }
        }
        return { at: this.now(), servers }
      } catch {
        return { at: this.now(), servers: null }
      }
    })().then((snapshot) => {
      if (this.sources.get(agentId) === source) this.snapshots.set(agentId, snapshot)
      this.inflight.delete(agentId)
      return snapshot
    })
    this.inflight.set(agentId, task)
    return task
  }
}
