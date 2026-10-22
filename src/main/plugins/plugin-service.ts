import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AppErrorException } from '../../shared/errors'
import type { PluginKind, PluginProgress, PluginRow } from '../../shared/types/plugins'
import type { CliResolver } from '../agents/cli-resolver'
import { parsePluginList, repoSettingsWarnings, type InstalledPlugin } from './plugin-view'

/**
 * Plugin management through the `claude plugin` subcommands (spec 005, tech spec 2.7). This file
 * holds the execution helper (reused by the later changes) and the read-only list: Arc never
 * writes to `~/.claude`; only the CLI does.
 */

export const LIST_TIMEOUT_MS = 15_000
export const INSTALL_TIMEOUT_MS = 5 * 60_000
export const UNINSTALL_TIMEOUT_MS = 60_000
/** What a change that Arc's quit cut short reports. */
export const QUIT_MESSAGE = 'Cancelled because Arc quit'
const MAX_BUFFER = 8 * 1024 * 1024
const ERROR_CAP = 2048
const KILL_GRACE_MS = 2000
// eslint-disable-next-line no-control-regex -- matching terminal escape sequences is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

export interface PluginLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface PluginServiceDeps {
  resolver: Pick<CliResolver, 'claudeBinary' | 'resolvePath'>
  /** Defaults to `process.env`; `HOME` locates `~/.claude` and goes to the CLI. */
  env?: NodeJS.ProcessEnv
  log?: PluginLog
  /** Progress of an async change (`plugins:progress`). */
  onProgress?: (event: PluginProgress) => void
  /**
   * Runs after a change succeeded and before `done` is reported: rebuild the plugin view, drop the
   * command caches, tell the pages and the brains. A failure here is logged, never reported as the change failing.
   */
  onChanged?: (kind: PluginKind) => Promise<void>
  /** Overrides the time limits of changes (tests). */
  timeouts?: Partial<{ install: number; uninstall: number }>
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

function cap(text: string): string {
  const clean = stripAnsi(text).trim()
  return clean.length > ERROR_CAP ? clean.slice(0, ERROR_CAP) : clean
}

/** The CLI's own words: the JSON `error` / `message`, else stderr, else stdout. */
export function errorText(stdout: string, stderr: string): string {
  const out = stripAnsi(stdout).trim()
  if (out.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(out)
      if (isRecord(parsed)) {
        const message = str(parsed['error']) ?? str(parsed['message'])
        if (message) return cap(message)
      }
    } catch {
      // Not JSON after all: fall through to the plain text.
    }
  }
  return cap(stderr) || cap(stdout)
}

export interface RunOptions {
  timeoutMs: number
  /** Aborting kills the process group and rejects with `PLUGIN_FAILED` carrying `abortReason`. */
  signal?: AbortSignal
  abortReason?: string
}

/** The environment a plugin command sees: no credentials, no Electron or Node settings. */
export function buildPluginEnv(base: NodeJS.ProcessEnv, path: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['HOME', 'USER', 'LANG', 'TMPDIR']) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  if (base['HARNESS_E2E'] === '1') {
    for (const [key, value] of Object.entries(base)) {
      if (key.startsWith('FAKE_CLAUDE_') && value !== undefined) env[key] = value
    }
  }
  env['PATH'] = path
  env['GIT_TERMINAL_PROMPT'] = '0'
  return env
}

const MUTATION_FLAGS = ['-s', 'user', '--json', '-y'] as const

function failureReason(error: unknown): string {
  if (error instanceof AppErrorException) {
    const reason = error.details?.['reason']
    if (typeof reason === 'string' && reason !== '') return reason
  }
  return error instanceof Error ? cap(error.message) : 'The plugin change failed.'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Counts `*.md` files under a folder, nested folders included. */
async function countMarkdown(dir: string, recursive: boolean): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (recursive) count += await countMarkdown(join(dir, entry.name), true)
    } else if (entry.name.endsWith('.md')) {
      count += 1
    }
  }
  return count
}

async function countSkills(dir: string): Promise<number> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (await exists(join(dir, entry.name, 'SKILL.md'))) count += 1
  }
  return count
}

function authorName(value: unknown): string | undefined {
  if (typeof value === 'string') return str(value)
  return isRecord(value) ? str(value['name']) : undefined
}

function isSha(version: string): boolean {
  return /^[0-9a-f]{12,40}$/i.test(version)
}

/** Dotted numeric parts (`1.2.3`, `v2.0`); `undefined` when the text is not a plain version. */
function versionParts(version: string): number[] | undefined {
  const match = /^v?(\d+(?:\.\d+)*)(?:[-+].*)?$/.exec(version.trim())
  return match?.[1] ? match[1].split('.').map(Number) : undefined
}

/** True when `latest` is a higher dotted version than `installed`; unparsable versions never compare. */
function isNewer(latest: string, installed: string): boolean {
  const a = versionParts(latest)
  const b = versionParts(installed)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

function samePrefix(a: string, b: string): boolean {
  const length = Math.min(a.length, b.length)
  return a.slice(0, length).toLowerCase() === b.slice(0, length).toLowerCase()
}

/**
 * Compares the installed version with the plugin's entry in the marketplace manifest. The entry's
 * `version` wins; a sha-like installed version (or none) is compared by prefix with the entry's
 * `source.sha`, or with the recorded commit when the entry only has a sha. Nothing comparable: no flag.
 */
export function updateFor(
  installed: string,
  entry: Record<string, unknown> | undefined,
  recordedSha: string | undefined
): string | undefined {
  if (!entry) return undefined
  const version = str(entry['version'])
  const source = entry['source']
  const sourceSha = isRecord(source) ? str(source['sha']) : undefined
  if (version && !isSha(installed) && !isSha(version)) {
    return isNewer(version, installed) ? version : undefined
  }
  const latestSha = sourceSha ?? (version && isSha(version) ? version : undefined)
  if (!latestSha) return undefined
  const current = isSha(installed) ? installed : recordedSha
  if (!current) return undefined
  return samePrefix(latestSha, current) ? undefined : latestSha.slice(0, 12)
}

function sourceText(value: unknown): string | undefined {
  if (typeof value === 'string') return str(value)
  if (!isRecord(value)) return undefined
  return str(value['repo']) ?? str(value['url']) ?? str(value['path']) ?? str(value['source'])
}

interface Catalogue {
  entries: Map<string, Record<string, unknown>>
}

export class PluginService {
  private readonly env: NodeJS.ProcessEnv
  private readonly log: PluginLog
  /** The one change that is running; `list` waits for `settled`. */
  private active: { opId: string; abort: AbortController; settled: Promise<void> } | undefined

  constructor(private readonly deps: PluginServiceDeps) {
    this.env = deps.env ?? process.env
    this.log = deps.log ?? { warn: () => undefined }
  }

  private home(): string {
    return this.env['HOME'] || homedir()
  }

  /**
   * Runs `claude plugin <args>` and returns stdout. A non-zero exit or a timeout becomes
   * `PLUGIN_FAILED` whose `details.reason` is the CLI's own message. The process group is killed
   * on a timeout.
   */
  async run(args: readonly string[], options: RunOptions): Promise<string> {
    const path = await this.deps.resolver.resolvePath()
    const env = buildPluginEnv(this.env, path)
    const binary = this.deps.resolver.claudeBinary()
    return new Promise<string>((resolve, reject) => {
      // A process group of its own, so a timeout can take down whatever the CLI started.
      const child = spawn(binary, ['plugin', ...args], {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let overflow = false
      let timedOut = false
      let settled = false
      let aborted = false
      let forceTimer: NodeJS.Timeout | undefined
      const killGroup = (signal: NodeJS.Signals): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, signal)
        } catch {
          try {
            child.kill(signal)
          } catch {
            // Already gone.
          }
        }
      }
      const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
        if (stdout.length + stderr.length > MAX_BUFFER) {
          if (!overflow) {
            overflow = true
            killGroup('SIGKILL')
          }
          return
        }
        if (which === 'out') stdout += chunk.toString('utf8')
        else stderr += chunk.toString('utf8')
      }
      child.stdout.on('data', collect('out'))
      child.stderr.on('data', collect('err'))
      const timer = setTimeout(() => {
        timedOut = true
        killGroup('SIGTERM')
        forceTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      }, options.timeoutMs)
      const onAbort = (): void => {
        aborted = true
        killGroup('SIGTERM')
        forceTimer ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
      }
      if (options.signal?.aborted) onAbort()
      else options.signal?.addEventListener('abort', onAbort, { once: true })
      const finish = (code: number | null, failure: Error | undefined): void => {
        clearTimeout(timer)
        clearTimeout(forceTimer)
        options.signal?.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        if (aborted) {
          reject(
            new AppErrorException('PLUGIN_FAILED', {
              reason: options.abortReason ?? 'Cancelled.'
            })
          )
        } else if (timedOut) {
          reject(
            new AppErrorException('PLUGIN_FAILED', {
              reason: `Claude Code did not finish within ${Math.round(options.timeoutMs / 1000)} seconds.`
            })
          )
        } else if (overflow) {
          reject(
            new AppErrorException('PLUGIN_FAILED', {
              reason: 'Claude Code printed too much output.'
            })
          )
        } else if (failure || code !== 0) {
          const missing = failure !== undefined && 'code' in failure && failure.code === 'ENOENT'
          const reason =
            errorText(stdout, stderr) ||
            (missing
              ? "Claude Code isn't installed."
              : failure
                ? cap(failure.message)
                : `Claude Code exited with code ${code}.`)
          this.log.warn(`claude plugin ${args[0] ?? ''} failed`, reason)
          reject(new AppErrorException('PLUGIN_FAILED', { reason }))
        } else {
          resolve(stdout)
        }
      }
      child.on('error', (error) => finish(null, error))
      // `close` waits for the pipes, so output a child left behind is still read.
      child.on('close', (code) => finish(code, undefined))
    })
  }

  /** User-scope plugins, one row per id, with details read from disk. */
  async list(): Promise<PluginRow[]> {
    // A change in progress rewrites what the list reads.
    await this.active?.settled
    const stdout = await this.run(['list', '--json'], { timeoutMs: LIST_TIMEOUT_MS })
    let installed: InstalledPlugin[]
    try {
      installed = parsePluginList(stdout)
    } catch (error: unknown) {
      this.log.warn('could not read the plugin list', error)
      throw new AppErrorException('PLUGIN_FAILED', {
        reason: 'Claude Code returned a plugin list Arc could not read.'
      })
    }
    const byId = new Map<string, InstalledPlugin>()
    for (const entry of installed) {
      if (entry.scope !== 'user') continue
      const prior = byId.get(entry.id)
      if (!prior || entry.lastUpdated > prior.lastUpdated) byId.set(entry.id, entry)
    }
    const pluginsDir = join(this.home(), '.claude', 'plugins')
    const known = (await readJson(join(pluginsDir, 'known_marketplaces.json'))) ?? {}
    const recorded = await readJson(join(pluginsDir, 'installed_plugins.json'))
    const catalogues = new Map<string, Catalogue>()
    const rows: PluginRow[] = []
    for (const plugin of byId.values()) {
      rows.push(await this.row(plugin, pluginsDir, known, recorded, catalogues))
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    return rows
  }

  /** `plugin install <name>[@marketplace]`; returns the op id at once. */
  install(name: string, marketplace?: string): { opId: string } {
    const target = marketplace ? `${name}@${marketplace}` : name
    return this.start('install', target, ['install', target, ...MUTATION_FLAGS], this.longLimit())
  }

  update(id: string): { opId: string } {
    return this.start('update', id, ['update', id, ...MUTATION_FLAGS], this.longLimit())
  }

  uninstall(id: string): { opId: string } {
    return this.start(
      'uninstall',
      id,
      ['uninstall', id, ...MUTATION_FLAGS],
      this.deps.timeouts?.uninstall ?? UNINSTALL_TIMEOUT_MS
    )
  }

  /** Refreshes the marketplaces (`plugin marketplace update`); the only time Arc does. */
  checkUpdates(): { opId: string } {
    return this.start('check-updates', '', ['marketplace', 'update', '--json'], this.longLimit())
  }

  private longLimit(): number {
    return this.deps.timeouts?.install ?? INSTALL_TIMEOUT_MS
  }

  /** Quit: kills the running change and waits until it has reported `failed`. */
  async cancelForQuit(): Promise<void> {
    const active = this.active
    if (!active) return
    active.abort.abort()
    await active.settled
  }

  private start(
    kind: PluginKind,
    target: string,
    args: readonly string[],
    timeoutMs: number
  ): { opId: string } {
    if (this.active) throw new AppErrorException('PLUGIN_BUSY')
    const opId = randomUUID()
    const abort = new AbortController()
    const progress = (state: PluginProgress['state'], message?: string): void => {
      this.deps.onProgress?.({
        opId,
        kind,
        target,
        state,
        ...(message !== undefined ? { message } : {})
      })
    }
    const settled = (async (): Promise<void> => {
      progress('running')
      try {
        await this.run(args, {
          timeoutMs,
          signal: abort.signal,
          abortReason: QUIT_MESSAGE
        })
        try {
          await this.deps.onChanged?.(kind)
        } catch (error: unknown) {
          this.log.warn('could not refresh after a plugin change', error)
        }
        this.active = undefined
        progress('done')
      } catch (error: unknown) {
        this.active = undefined
        progress('failed', failureReason(error))
      }
    })()
    this.active = { opId, abort, settled }
    return { opId }
  }

  private async catalogue(
    pluginsDir: string,
    marketplace: string,
    cache: Map<string, Catalogue>
  ): Promise<Catalogue> {
    const cached = cache.get(marketplace)
    if (cached) return cached
    const manifest = await readJson(
      join(pluginsDir, 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json')
    )
    const entries = new Map<string, Record<string, unknown>>()
    const plugins = manifest?.['plugins']
    if (Array.isArray(plugins)) {
      for (const item of plugins as unknown[]) {
        if (isRecord(item) && typeof item['name'] === 'string') entries.set(item['name'], item)
      }
    }
    const made = { entries }
    cache.set(marketplace, made)
    return made
  }

  private async row(
    plugin: InstalledPlugin,
    pluginsDir: string,
    known: Record<string, unknown>,
    recorded: Record<string, unknown> | undefined,
    catalogues: Map<string, Catalogue>
  ): Promise<PluginRow> {
    const at = plugin.id.indexOf('@')
    const name = at === -1 ? plugin.id : plugin.id.slice(0, at)
    const marketplace = at === -1 ? '' : plugin.id.slice(at + 1)
    const dir = plugin.installPath
    const manifest = (await readJson(join(dir, '.claude-plugin', 'plugin.json'))) ?? {}
    const entry = marketplace
      ? (await this.catalogue(pluginsDir, marketplace, catalogues)).entries.get(name)
      : undefined

    const mcpFromManifest = manifest['mcpServers']
    const hooksFromManifest = manifest['hooks']
    const [commands, skills, agents, mcpFile, hooksDir, hooksFile] = await Promise.all([
      countMarkdown(join(dir, 'commands'), true),
      countSkills(join(dir, 'skills')),
      countMarkdown(join(dir, 'agents'), false),
      exists(join(dir, '.mcp.json')),
      exists(join(dir, 'hooks')),
      exists(join(dir, 'hooks.json'))
    ])

    const installs = recorded?.['plugins']
    const records = isRecord(installs) ? installs[plugin.id] : undefined
    const record = Array.isArray(records)
      ? (records as unknown[]).find(
          (r) => isRecord(r) && r['scope'] === 'user' && r['installPath'] === dir
        )
      : undefined
    const recordedSha = isRecord(record) ? str(record['gitCommitSha']) : undefined

    const version = str(manifest['version']) ?? plugin.version
    const update = updateFor(plugin.version || version, entry, recordedSha)
    const author = authorName(manifest['author']) ?? authorName(entry?.['author'])
    const marketplaceInfo = marketplace ? known[marketplace] : undefined
    const source = isRecord(marketplaceInfo) ? sourceText(marketplaceInfo['source']) : undefined
    return {
      id: plugin.id,
      name,
      marketplace,
      version: plugin.version || version,
      description: str(manifest['description']) ?? str(entry?.['description']) ?? '',
      ...(author ? { author } : {}),
      enabled: plugin.enabled,
      ...(source ? { source } : {}),
      counts: { commands, skills, agents },
      hasMcp:
        mcpFile ||
        (isRecord(mcpFromManifest) && Object.keys(mcpFromManifest).length > 0) ||
        typeof mcpFromManifest === 'string',
      hasHooks:
        hooksDir || hooksFile || (hooksFromManifest !== undefined && hooksFromManifest !== null),
      ...(update ? { updateAvailable: update } : {})
    }
  }
}

/** What the repository's own settings do inside agents, in the words of the session log. */
export function warningText(name: string, hooks: boolean, plugins: boolean): string {
  const head = `${name} has its own Claude Code settings:`
  if (hooks && plugins) {
    return `${head} its hooks will run in workers, and the plugins it turns on run without their hooks.`
  }
  if (hooks) return `${head} its hooks will run in workers.`
  return `${head} the plugins it turns on run in workers without their hooks.`
}

export interface RepoWarnerDeps {
  /** Defaults to the read-only check of the plugin view. */
  warnings?: typeof repoSettingsWarnings
}

/**
 * Tells the session's event log once per repository that the repository's own Claude Code settings
 * (hooks, enabled plugins) apply inside agents working there (spec 005, functional spec 2.8).
 */
export class RepoSettingsWarner {
  private readonly warned = new Map<string, Set<string>>()

  constructor(private readonly deps: RepoWarnerDeps = {}) {}

  async check(
    sessionId: string,
    repos: readonly { name: string; path: string }[],
    logEvent: (kind: string, text: string) => void
  ): Promise<void> {
    const seen = this.warned.get(sessionId) ?? new Set<string>()
    this.warned.set(sessionId, seen)
    for (const repo of repos) {
      if (seen.has(repo.path)) continue
      seen.add(repo.path)
      let found
      try {
        found = await (this.deps.warnings ?? repoSettingsWarnings)(repo.path)
      } catch {
        continue
      }
      if (!found.hooks && found.enabledPlugins.length === 0) continue
      logEvent(
        'repo-settings',
        warningText(repo.name, found.hooks, found.enabledPlugins.length > 0)
      )
    }
  }

  forget(sessionId: string): void {
    this.warned.delete(sessionId)
  }
}
