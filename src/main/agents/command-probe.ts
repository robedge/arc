import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { AppErrorException } from '../../shared/errors'
import { commandId, type CommandInfo } from '../../shared/types/commands'
import { buildAgentEnv, type ProcessSupervisor } from './process-supervisor'

/**
 * The command catalogue (spec 005, tech spec 2.3). Claude Code answers a `control_request`
 * `initialize` on stdin with its slash commands and skills without a model call, so Arc lists them
 * by starting the CLI the way agents start (same plugin view, same setting sources), asking once
 * and closing it. Note: the CLI runs the repository's SessionStart hooks for that probe (spike S2).
 */

export const PROBE_TIMEOUT_MS = 10_000
export const PROBE_PARALLEL = 4
export const CATALOGUE_TTL_MS = 5 * 60_000
const STOP_GRACE_MS = 1000
const KILL_STEP_MS = 1500

/** A command exactly as the CLI reports it, built-ins already removed. */
export interface RawCommand {
  name: string
  description: string
  argumentHint?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The CLI's answer to `initialize`: `commands` with `builtin` set on the CLI's own commands. */
function parseCommandList(value: unknown): RawCommand[] {
  if (!Array.isArray(value)) return []
  const out: RawCommand[] = []
  for (const entry of value as unknown[]) {
    if (!isRecord(entry) || entry['builtin'] === true) continue
    const name = entry['name']
    if (typeof name !== 'string' || name === '') continue
    const description = entry['description']
    const hint = entry['argumentHint']
    out.push({
      name,
      description: typeof description === 'string' ? description : '',
      ...(typeof hint === 'string' && hint !== '' ? { argumentHint: hint } : {})
    })
  }
  return out
}

export type ProbeLine =
  { kind: 'commands'; commands: RawCommand[] } | { kind: 'error'; message: string }

/**
 * Reads one stdout line of the probe. Only the `control_response` for `requestId` counts; every
 * other line (system/hook_* from repository hooks, init, anything else) returns undefined.
 */
export function parseProbeLine(line: string, requestId: string): ProbeLine | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || parsed['type'] !== 'control_response') return undefined
  const response = parsed['response']
  if (!isRecord(response) || response['request_id'] !== requestId) return undefined
  if (response['subtype'] === 'error') {
    const message = response['error']
    return { kind: 'error', message: typeof message === 'string' ? message : 'initialize failed' }
  }
  const body = response['response']
  return { kind: 'commands', commands: parseCommandList(isRecord(body) ? body['commands'] : []) }
}

/** Source of one raw command. `undefined` drops it (a repo command with no repository to run in). */
export function mapCommand(
  raw: RawCommand,
  context: { pluginNames: ReadonlySet<string>; projectName: string | null }
): CommandInfo | undefined {
  // A prompt of a user's MCP server (`mcp__<server>__<prompt>`) is not a command Arc offers.
  if (raw.name.startsWith('mcp__')) return undefined
  const colon = raw.name.indexOf(':')
  const prefix = colon === -1 ? '' : raw.name.slice(0, colon)
  const hint = raw.argumentHint !== undefined ? { argumentHint: raw.argumentHint } : {}
  const base = { id: commandId('claude', raw.name), provider: 'claude', kind: 'command' } as const
  if (prefix === 'user') {
    return { ...base, name: raw.name, description: raw.description, ...hint, source: 'user' }
  }
  if (prefix !== '' && context.pluginNames.has(prefix)) {
    return {
      ...base,
      name: raw.name,
      description: raw.description,
      ...hint,
      source: `plugin:${prefix}`
    }
  }
  if (context.projectName === null) return undefined
  return {
    ...base,
    name: raw.name,
    description: raw.description.replace(/\s*\(project\)\s*$/, ''),
    ...hint,
    source: `repo:${context.projectName}`
  }
}

class Semaphore {
  private free: number
  private readonly waiters: (() => void)[] = []

  constructor(slots: number) {
    this.free = slots
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free -= 1
    else await new Promise<void>((resolve) => this.waiters.push(resolve))
    return () => {
      const next = this.waiters.shift()
      if (next) next()
      else this.free += 1
    }
  }
}

export interface CommandProbeDeps {
  supervisor: Pick<ProcessSupervisor, 'spawn'>
  /** `CliResolver.claudeBinary()`. */
  binary: string
  /** Args placed before the CLI's own (tests run a node script this way). */
  binaryArgs?: readonly string[]
  /** `CliResolver.resolvePath()`. */
  resolvePath: () => Promise<string>
  env?: NodeJS.ProcessEnv
  /** Applied last to the child env (tests). */
  extraEnv?: Readonly<Record<string, string>>
  timeoutMs?: number
  maxParallel?: number
  /** Wait after closing stdin before the process group is signalled. */
  stopGraceMs?: number
  newId?: () => string
}

/** The generated hooks and MCP files agents start with (spec 007 section 2.6); the probe gets the same ones. */
export interface ProbePersonalFiles {
  hooksSettingsPath?: string | undefined
  mcpConfigPath?: string | undefined
}

/** The flag set agents start with (without Arc's bridge), so the command list is what agents see. */
export function buildProbeArgs(
  pluginViewDir: string | undefined,
  personal: ProbePersonalFiles = {}
): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    'project',
    ...(personal.hooksSettingsPath ? ['--settings', personal.hooksSettingsPath] : []),
    ...(personal.mcpConfigPath ? [`--mcp-config=${personal.mcpConfigPath}`] : []),
    '--strict-mcp-config',
    ...(pluginViewDir ? ['--plugin-dir', pluginViewDir] : [])
  ]
}

/** Starts the CLI, asks for its commands and stops it again. */
export class CommandProbe {
  private readonly slots: Semaphore

  constructor(private readonly deps: CommandProbeDeps) {
    this.slots = new Semaphore(deps.maxParallel ?? PROBE_PARALLEL)
  }

  /** Built-ins are already dropped. Rejects on timeout, an early exit or an error answer. */
  async run(
    cwd: string,
    pluginViewDir: string | undefined,
    personal?: ProbePersonalFiles
  ): Promise<RawCommand[]> {
    const release = await this.slots.acquire()
    try {
      return await this.exchange(cwd, pluginViewDir, personal)
    } finally {
      release()
    }
  }

  private async exchange(
    cwd: string,
    pluginViewDir: string | undefined,
    personal: ProbePersonalFiles | undefined
  ): Promise<RawCommand[]> {
    const newId = this.deps.newId ?? randomUUID
    const path = await this.deps.resolvePath()
    const requestId = newId()
    const proc = this.deps.supervisor.spawn({
      command: this.deps.binary,
      args: [...(this.deps.binaryArgs ?? []), ...buildProbeArgs(pluginViewDir, personal)],
      cwd,
      env: buildAgentEnv(this.deps.env ?? process.env, path, this.deps.extraEnv),
      agentId: `command-probe-${requestId}`
    })
    const answer = new Promise<RawCommand[]>((resolve, reject) => {
      proc.onLine((line) => {
        const result = parseProbeLine(line, requestId)
        if (!result) return
        if (result.kind === 'commands') resolve(result.commands)
        else reject(new Error(result.message))
      })
      void proc.exited.then((info) => {
        const reason = info.spawnError?.message ?? info.stderrTail.trim().slice(-300)
        reject(new Error(`the CLI exited before answering${reason ? `: ${reason}` : ''}`))
      })
    })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('the CLI did not answer in time')),
        this.deps.timeoutMs ?? PROBE_TIMEOUT_MS
      )
    })
    proc.writeLine(
      JSON.stringify({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'initialize' }
      })
    )
    try {
      return await Promise.race([answer, timeout])
    } finally {
      clearTimeout(timer)
      await this.stop(proc)
    }
  }

  /** Closes stdin, then signals the process group if the CLI is still there. */
  private async stop(proc: ReturnType<ProcessSupervisor['spawn']>): Promise<void> {
    proc.expectExit()
    proc.endStdin()
    if (proc.hasExited()) return
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      proc.exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.deps.stopGraceMs ?? STOP_GRACE_MS)
      })
    ])
    clearTimeout(timer)
    if (proc.hasExited()) return
    await proc.killLadder([
      { signal: 'SIGTERM', waitMs: KILL_STEP_MS },
      { signal: 'SIGKILL', waitMs: KILL_STEP_MS }
    ])
  }
}

export interface CatalogueRepo {
  /** The project's display name, used as `repo:<name>`. */
  name: string
  path: string
}

export interface CatalogueRequest {
  /** The session's active repositories (git or not). */
  repos: readonly CatalogueRepo[]
  /** Where to probe when the session has no repositories (the brain's folder). */
  fallbackCwd: string
  /** Probe again even when the cache is fresh; the plugin view is rebuilt first. */
  refresh?: boolean
}

export interface CommandCatalogueDeps {
  probe: Pick<CommandProbe, 'run'>
  /** The plugin view folder (`undefined` when it could not be built); `refresh` rebuilds it first. */
  getViewDir: (repoPaths: readonly string[], refresh: boolean) => Promise<string | undefined>
  /**
   * The generated hooks and MCP files for a probe in these folders (the same ones agents get); left
   * out or `undefined`, the probe runs without personal hooks and servers.
   */
  getPersonal?: (repoPaths: readonly string[]) => Promise<ProbePersonalFiles | undefined>
  /**
   * The user's Codex skills and prompts for these folders, with their own cache; empty while Codex is
   * not ready. Optional so a session without Codex lists Claude commands only.
   */
  codex?: { list: (cwds: readonly string[], refresh: boolean) => Promise<CommandInfo[]> }
  /** The Cursor commands and skills, empty while Cursor is not ready; optional like `codex`. */
  cursor?: { list: (cwds: readonly string[], refresh: boolean) => Promise<CommandInfo[]> }
  log?: { warn: (message: string, ...rest: unknown[]) => void }
  now?: () => number
  ttlMs?: number
}

interface CacheEntry {
  hash: string
  mtime: number
  at: number
  commands: RawCommand[]
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Newest modification time of a folder tree (the folders themselves included); 0 when it is missing. */
export async function newestMtime(root: string): Promise<number> {
  let newest = 0
  const walk = async (dir: string): Promise<void> => {
    try {
      newest = Math.max(newest, (await stat(dir)).mtimeMs)
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else newest = Math.max(newest, (await stat(full)).mtimeMs)
      }
    } catch {
      // A missing or unreadable folder counts as unchanged.
    }
  }
  await walk(root)
  return newest
}

/** Plugin names in a view folder: its sub-folders, without the `user` wrapper. */
async function pluginNamesOf(viewDir: string | undefined): Promise<Set<string>> {
  if (!viewDir) return new Set()
  try {
    const entries = await readdir(viewDir, { withFileTypes: true })
    return new Set(entries.filter((e) => e.isDirectory() && e.name !== 'user').map((e) => e.name))
  } catch {
    return new Set()
  }
}

/** Where a source sits in the list: the user's first, then plugins, repositories, Codex and Cursor. */
const SOURCE_RANK: Readonly<Record<string, number>> = {
  user: 0,
  plugin: 1,
  repo: 2,
  codex: 3,
  cursor: 4
}

function sourceRank(source: string): number {
  return SOURCE_RANK[source.split(':')[0] ?? ''] ?? SOURCE_RANK['repo'] ?? 2
}

/** The merged, cached command list of a session. */
export class CommandCatalogue {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly inflight = new Map<string, Promise<RawCommand[]>>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: CommandCatalogueDeps) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? CATALOGUE_TTL_MS
  }

  /**
   * One probe per repository that has a `.claude` folder; when none has, one probe in the first
   * repository (or the fallback folder) for the user and plugin commands. User and plugin entries
   * are deduped by name, repository entries stay with their repository. A repository whose probe
   * fails is left out; when every probe fails the call fails.
   */
  async list(request: CatalogueRequest): Promise<CommandInfo[]> {
    const refresh = request.refresh === true
    const viewDir = await this.deps.getViewDir(
      request.repos.map((r) => r.path),
      refresh
    )
    const viewHash = viewDir ? basename(viewDir) : 'none'
    const pluginNames = await pluginNamesOf(viewDir)

    const withClaude: CatalogueRepo[] = []
    for (const repo of request.repos) {
      if (await pathExists(join(repo.path, '.claude'))) withClaude.push(repo)
    }
    const first = request.repos[0]
    const targets: { name: string | null; path: string }[] =
      withClaude.length > 0 ? withClaude : [first ?? { name: null, path: request.fallbackCwd }]

    const settled = await Promise.allSettled(
      targets.map((t) => this.commandsFor(t.path, viewDir, viewHash, refresh))
    )
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    for (const f of failed) this.deps.log?.warn('could not list the commands of a folder', f.reason)
    const codex = await this.otherEntries('Codex', this.deps.codex, request, refresh)
    const cursor = await this.otherEntries('Cursor', this.deps.cursor, request, refresh)
    if (failed.length === settled.length && codex.length + cursor.length === 0) {
      throw new AppErrorException('INTERNAL', { reason: 'could not list commands' })
    }

    const merged = new Map<string, CommandInfo>()
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      const projectName = targets[index]?.name ?? null
      for (const raw of result.value) {
        const info = mapCommand(raw, { pluginNames, projectName })
        if (!info) continue
        const key = info.source.startsWith('repo:')
          ? `${info.source}\u0000${info.name}`
          : `shared\u0000${info.name}`
        if (!merged.has(key)) merged.set(key, info)
      }
    })
    return [...merged.values(), ...codex, ...cursor].sort(
      (a, b) =>
        sourceRank(a.source) - sourceRank(b.source) ||
        a.source.localeCompare(b.source) ||
        a.name.localeCompare(b.name)
    )
  }

  /** Codex or Cursor entries; a list that fails leaves them out and never fails the Claude list. */
  private async otherEntries(
    label: string,
    source: CommandCatalogueDeps['codex'],
    request: CatalogueRequest,
    refresh: boolean
  ): Promise<CommandInfo[]> {
    if (!source) return []
    const cwds = request.repos.length > 0 ? request.repos.map((r) => r.path) : [request.fallbackCwd]
    try {
      return await source.list(cwds, refresh)
    } catch (error: unknown) {
      this.deps.log?.warn(`could not list the ${label} commands`, error)
      return []
    }
  }

  /** Drops every cached list (a plugin changed). */
  invalidate(): void {
    this.cache.clear()
  }

  private async personalFiles(cwd: string): Promise<ProbePersonalFiles | undefined> {
    if (!this.deps.getPersonal) return undefined
    try {
      return await this.deps.getPersonal([cwd])
    } catch (error: unknown) {
      this.deps.log?.warn('could not prepare the personal hooks and MCP servers for a probe', error)
      return undefined
    }
  }

  private async commandsFor(
    cwd: string,
    viewDir: string | undefined,
    viewHash: string,
    refresh: boolean
  ): Promise<RawCommand[]> {
    const personal = await this.personalFiles(cwd)
    // A changed hooks or MCP file (they are named by their content) makes a new list.
    const hash = `${viewHash}:${personal?.mcpConfigPath ?? ''}:${personal?.hooksSettingsPath ?? ''}`
    const mtime = Math.max(
      await newestMtime(join(cwd, '.claude', 'commands')),
      await newestMtime(join(cwd, '.claude', 'skills'))
    )
    const cached = this.cache.get(cwd)
    if (
      !refresh &&
      cached &&
      cached.hash === hash &&
      cached.mtime === mtime &&
      this.now() - cached.at < this.ttlMs
    ) {
      return cached.commands
    }
    const key = `${hash}\u0000${cwd}\u0000${mtime}`
    const running = this.inflight.get(key)
    if (running && !refresh) return running
    const task = this.deps.probe
      .run(cwd, viewDir, personal)
      .then((commands) => {
        this.cache.set(cwd, { hash, mtime, at: this.now(), commands })
        return commands
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }
}
