import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultExec, type CliResolver, type ExecFn } from '../agents/cli-resolver'
import { loadKey, type LoadRole } from '../../shared/types/agent-load'
import { skillFolders } from '../personal/load-listing'
import { NOTHING_OFF, type OffFor } from '../personal/load-selection'

/**
 * The plugin view (spec 005, tech spec 2.2; spec 007 section 2.6): one folder of sanitized plugins
 * handed to every agent with `--plugin-dir`. Plugins are re-assembled here from their installed
 * copies: commands, skills, agents, hooks and MCP definitions are kept (the user's plugins' hooks and
 * servers load in Arc agents), while LSP servers and plugin `settings` never reach an agent.
 * Nothing here writes to `~/.claude`.
 */

/** Both roles' current views are always kept; this many in total otherwise. */
const KEEP_VIEWS = 4
const LIST_TIMEOUT_MS = 15_000
const LIST_CACHE_MS = 10_000
/** Bumped when the layout of a view changes, so a view built the old way is never reused. */
const VIEW_FORMAT = 2
/**
 * Top-level entries of an installed plugin that are not linked into its view: the manifest folder
 * (rewritten), LSP servers and plugin settings (spec 007: still stripped), and git data. Everything
 * else is linked, so `${CLAUDE_PLUGIN_ROOT}/...` paths in hooks resolve inside the view.
 */
const UNLINKED_ENTRIES: ReadonlySet<string> = new Set([
  '.claude-plugin',
  '.lsp.json',
  'settings.json',
  '.git'
])
/** The only `plugin.json` keys that are copied. `lspServers` and `settings` are not among them. */
const ALLOWED_MANIFEST_KEYS = ['name', 'version', 'description', 'hooks', 'mcpServers'] as const

export interface InstalledPlugin {
  /** `name@marketplace`. */
  id: string
  scope: string
  enabled: boolean
  version: string
  installPath: string
  lastUpdated: string
}

export interface PluginViewLog {
  warn: (message: string, ...rest: unknown[]) => void
}

export interface PluginViewDeps {
  /** `userData/agent-plugins`. */
  baseDir: string
  /** `claude plugin list --json`, already parsed. */
  listInstalled: () => Promise<readonly InstalledPlugin[]>
  /** Read per build so tests can fake it (default: the process HOME). */
  getHome?: () => string
  log?: PluginViewLog
  /** A later build changed which view is current (not called for the first one). */
  onChanged?: (viewDir: string) => void
  /** Views to keep besides the current ones (default 4 in total). */
  keep?: number
  /** What the user switched off per role (spec 009); left out, everything is on. */
  off?: OffFor
}

export interface RepoSettingsWarnings {
  /** The repository's `.claude/settings.json` declares hooks; they run inside every agent there. */
  hooks: boolean
  /** Plugin ids the repository enables (value true). */
  enabledPlugins: string[]
}

interface RepoSettings {
  hooks: boolean
  enabledPlugins: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Reads a repository's `.claude/settings.json` read-only; a missing or broken file counts as empty. */
async function readRepoSettings(repoPath: string): Promise<RepoSettings> {
  const empty: RepoSettings = { hooks: false, enabledPlugins: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(repoPath, '.claude', 'settings.json'), 'utf8'))
  } catch {
    return empty
  }
  if (!isRecord(parsed)) return empty
  const hooks = isRecord(parsed['hooks']) && Object.keys(parsed['hooks']).length > 0
  const plugins = parsed['enabledPlugins']
  const enabledPlugins = isRecord(plugins)
    ? Object.entries(plugins)
        .filter(([, on]) => on === true)
        .map(([id]) => id)
    : []
  return { hooks, enabledPlugins }
}

/** What the later warning needs: do this repository's own settings run hooks or pull in plugins. */
export async function repoSettingsWarnings(repoPath: string): Promise<RepoSettingsWarnings> {
  const { hooks, enabledPlugins } = await readRepoSettings(repoPath)
  return { hooks, enabledPlugins }
}

/** Accepts both `[...]` and `{ installed: [...] }`; entries without an id or install path are dropped. */
export function parsePluginList(raw: string): InstalledPlugin[] {
  const parsed: unknown = JSON.parse(raw)
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed['installed'])
      ? parsed['installed']
      : []
  const out: InstalledPlugin[] = []
  for (const row of rows as unknown[]) {
    if (!isRecord(row)) continue
    const id = str(row['id'])
    const installPath = str(row['installPath'])
    if (!id || !installPath) continue
    out.push({
      id,
      scope: str(row['scope']) ?? '',
      enabled: row['enabled'] === true,
      version: str(row['version']) ?? '',
      installPath,
      lastUpdated: str(row['lastUpdated']) ?? ''
    })
  }
  return out
}

export interface ClaudePluginListerDeps {
  resolver: Pick<CliResolver, 'claudeBinary' | 'resolvePath'>
  exec?: ExecFn
  env?: NodeJS.ProcessEnv
}

/** `claude plugin list --json` through the resolved binary (read-only). */
export function createClaudePluginLister(
  deps: ClaudePluginListerDeps
): () => Promise<InstalledPlugin[]> {
  return async () => {
    const path = await deps.resolver.resolvePath()
    const env = { ...(deps.env ?? process.env), PATH: path }
    const { stdout } = await (deps.exec ?? defaultExec)(
      deps.resolver.claudeBinary(),
      ['plugin', 'list', '--json'],
      {
        timeout: LIST_TIMEOUT_MS,
        env
      }
    )
    return parsePluginList(stdout)
  }
}

/** Newest `lastUpdated` wins; ids repeat across scopes and projects. */
function dedupeById(list: readonly InstalledPlugin[]): Map<string, InstalledPlugin> {
  const byId = new Map<string, InstalledPlugin>()
  for (const entry of list) {
    const prior = byId.get(entry.id)
    if (!prior || entry.lastUpdated > prior.lastUpdated) byId.set(entry.id, entry)
  }
  return byId
}

interface Source {
  plugin: InstalledPlugin
  /** `name` and `description` from the installed `plugin.json`. */
  name: string
  description: string | undefined
  version: string
  manifestMtime: number
  /** The installed `plugin.json`, as read. */
  manifest: Record<string, unknown>
  /**
   * A plugin the user switched off that a repository still enables: written as a manifest-only
   * folder so the same-name inline copy keeps the CLI from loading the raw plugin (spec 009).
   */
  stub: boolean
}

/** What the personal configuration needs of a plugin that is in the view. */
export interface PluginViewSource {
  id: string
  /** The folder name in the view, which is also the plugin's name for the CLI. */
  folder: string
  installPath: string
  /** The installed `plugin.json`, as read (empty when it could not be read). */
  manifest: Record<string, unknown>
}

async function readSource(plugin: InstalledPlugin): Promise<Source | null> {
  const manifestPath = join(plugin.installPath, '.claude-plugin', 'plugin.json')
  try {
    await access(plugin.installPath)
  } catch {
    return null
  }
  let manifest: Record<string, unknown> = {}
  let manifestMtime = 0
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'))
    if (isRecord(parsed)) manifest = parsed
    manifestMtime = (await stat(manifestPath)).mtimeMs
  } catch {
    // A plugin without a readable manifest still loads: the id gives it a name.
  }
  const name = str(manifest['name']) ?? plugin.id.split('@')[0] ?? plugin.id
  return {
    plugin,
    name,
    description: str(manifest['description']),
    version: str(manifest['version']) ?? plugin.version,
    manifestMtime,
    manifest,
    stub: false
  }
}

async function realOrEmpty(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return ''
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

interface Plan {
  hash: string
  sources: Source[]
  home: string
  /**
   * The user skills to link one by one when some are switched off; null links `~/.claude/skills`
   * as one folder, as before.
   */
  skills: string[] | null
}

/** A role's current view: the folder, and the hash it was built for. */
interface Current {
  dir: string
  hash: string
}

function marketplaceOf(id: string): string {
  const at = id.indexOf('@')
  return at === -1 ? 'local' : id.slice(at + 1)
}

export class PluginViewService {
  private readonly keep: number
  private readonly log: PluginViewLog
  private readonly currents = new Map<LoadRole | 'any', Current>()
  private lastRepoPaths: readonly string[] = []
  private cache: { at: number; list: readonly InstalledPlugin[] } | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private swept = false
  private disposed = false

  constructor(private readonly deps: PluginViewDeps) {
    this.keep = deps.keep ?? KEEP_VIEWS
    this.log = deps.log ?? { warn: () => undefined }
  }

  /**
   * The folder to pass as `--plugin-dir`, rebuilt first when the hash of its sources changed.
   * `undefined` when the view cannot be built (the caller omits the flag).
   */
  current(groupRepoPaths: readonly string[] = [], role?: LoadRole): Promise<string | undefined> {
    this.lastRepoPaths = groupRepoPaths
    return this.serialize(() => this.ensure(groupRepoPaths, false, role))
  }

  /**
   * The plugins the view holds for these repositories (the same selection as `current`), with the
   * installed manifest. The personal configuration reads their MCP servers from here.
   */
  sources(groupRepoPaths: readonly string[] = [], role?: LoadRole): Promise<PluginViewSource[]> {
    return this.serialize(async () => {
      try {
        const plan = await this.plan(groupRepoPaths, false, role)
        const names = folderNames(plan.sources)
        return plan.sources
          .filter((s) => !s.stub)
          .map((s) => ({
            id: s.plugin.id,
            folder: names.get(s.plugin.id) ?? s.name,
            installPath: s.plugin.installPath,
            manifest: s.manifest
          }))
      } catch (error: unknown) {
        this.log.warn('could not list the plugins of the view', error)
        return []
      }
    })
  }

  /** Re-reads the plugin list and builds again if anything changed. */
  rebuild(): Promise<string | undefined> {
    return this.serialize(() => this.ensure(this.lastRepoPaths, true, 'workers'))
  }

  /** Waits for a running build; later calls return the last good view without building. */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.chain.catch(() => undefined)
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.catch(() => undefined)
    return run
  }

  private async ensure(
    repoPaths: readonly string[],
    refresh: boolean,
    role: LoadRole | undefined
  ): Promise<string | undefined> {
    const slot = role ?? 'any'
    if (this.disposed) return this.currents.get(slot)?.dir
    try {
      await mkdir(this.deps.baseDir, { recursive: true })
      if (!this.swept) {
        this.swept = true
        await this.sweepTmp()
      }
      const plan = await this.plan(repoPaths, refresh, role)
      const target = join(this.deps.baseDir, plan.hash)
      const before = this.currents.get(slot)
      if (before?.hash === plan.hash && (await exists(target))) return target
      if (!(await exists(target))) await this.build(plan, target)
      const changed = before !== undefined && before.hash !== plan.hash
      this.currents.set(slot, { dir: target, hash: plan.hash })
      await this.prune()
      // The pages list commands from the workers' view; the brain's view changing tells them nothing.
      if (changed && role !== 'brain') this.deps.onChanged?.(target)
      return target
    } catch (error: unknown) {
      this.log.warn('could not build the plugin view', error)
      return undefined
    }
  }

  private async installed(refresh: boolean): Promise<readonly InstalledPlugin[]> {
    const now = Date.now()
    if (!refresh && this.cache && now - this.cache.at < LIST_CACHE_MS) return this.cache.list
    const list = await this.deps.listInstalled()
    this.cache = { at: now, list }
    return list
  }

  private async plan(
    repoPaths: readonly string[],
    refresh: boolean,
    role: LoadRole | undefined
  ): Promise<Plan> {
    const home = (this.deps.getHome ?? homedir)()
    const off = role ? (this.deps.off ?? NOTHING_OFF)(role) : new Set<string>()
    const all = await this.installed(refresh)
    const byId = dedupeById(all)

    const wanted = new Map<string, InstalledPlugin>(
      dedupeById(all.filter((e) => e.scope === 'user' && e.enabled))
    )

    // A repository's enabledPlugins would load the raw plugin (with hooks); a same-name inline copy wins.
    const shadowed = new Set<string>()
    for (const repo of repoPaths) {
      const { enabledPlugins } = await readRepoSettings(repo)
      for (const id of enabledPlugins) {
        const installed = byId.get(id)
        if (!installed) continue
        shadowed.add(id)
        if (!wanted.has(id)) wanted.set(id, installed)
      }
    }

    const sources: Source[] = []
    for (const plugin of wanted.values()) {
      const isOff = off.has(loadKey.plugin(plugin.id))
      // A plugin that is off is left out, unless a repository would load it anyway: then a stub holds its name.
      if (isOff && !shadowed.has(plugin.id)) continue
      const source = await readSource(plugin)
      if (source) sources.push(isOff ? { ...source, stub: true } : source)
      else this.log.warn(`plugin ${plugin.id} has no install folder; left out of the view`)
    }
    sources.sort((a, b) => (a.plugin.id < b.plugin.id ? -1 : a.plugin.id > b.plugin.id ? 1 : 0))

    // Only when some skill is off are the user's skills linked one by one.
    const userSkills = await skillFolders(join(home, '.claude', 'skills'))
    const keptSkills = userSkills.filter((name) => !off.has(loadKey.skill(name)))
    const skills = keptSkills.length === userSkills.length ? null : keptSkills

    const hash = createHash('sha1')
      .update(
        JSON.stringify({
          plugins: sources.map((s) => ({
            id: s.plugin.id,
            version: s.plugin.version,
            installPath: s.plugin.installPath,
            mtime: s.manifestMtime,
            stub: s.stub
          })),
          format: VIEW_FORMAT,
          skills: await realOrEmpty(join(home, '.claude', 'skills')),
          keptSkills: skills,
          commands: await realOrEmpty(join(home, '.claude', 'commands')),
          shadowed: [...shadowed].sort()
        })
      )
      .digest('hex')
    return { hash, sources, home, skills }
  }

  private async build(plan: Plan, target: string): Promise<void> {
    const tmp = join(this.deps.baseDir, `.tmp-${randomBytes(6).toString('hex')}`)
    try {
      await mkdir(tmp, { recursive: true })
      const names = folderNames(plan.sources)
      for (const source of plan.sources) {
        const name = names.get(source.plugin.id) ?? source.name
        await writePlugin(join(tmp, name), name, source)
      }
      await writeUserWrapper(join(tmp, 'user'), plan.home, plan.skills)
      try {
        await rename(tmp, target)
      } catch (error: unknown) {
        // Another build produced the same hash first: keep that one.
        if (!(await exists(target))) throw error
        await rm(tmp, { recursive: true, force: true })
      }
    } catch (error: unknown) {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  private async sweepTmp(): Promise<void> {
    for (const entry of await readdir(this.deps.baseDir).catch(() => [])) {
      if (entry.startsWith('.tmp-')) {
        await rm(join(this.deps.baseDir, entry), { recursive: true, force: true })
      }
    }
  }

  /** Keeps both roles' current views and the newest others, `keep` in all, and removes the rest. */
  private async prune(): Promise<void> {
    const current = new Set([...this.currents.values()].map((c) => c.hash))
    const views: { name: string; mtime: number }[] = []
    for (const entry of await readdir(this.deps.baseDir)) {
      if (entry.startsWith('.')) continue
      try {
        views.push({ name: entry, mtime: (await stat(join(this.deps.baseDir, entry))).mtimeMs })
      } catch {
        // Gone already.
      }
    }
    views.sort((a, b) => b.mtime - a.mtime)
    const others = views.map((v) => v.name).filter((n) => !current.has(n))
    const keepNames = new Set([...current, ...others].slice(0, Math.max(this.keep, current.size)))
    for (const view of views) {
      if (!keepNames.has(view.name)) {
        await rm(join(this.deps.baseDir, view.name), { recursive: true, force: true })
      }
    }
  }
}

/** Folder (and plugin) names: the manifest name, with the marketplace appended when two plugins share one. */
function folderNames(sources: readonly Source[]): Map<string, string> {
  const counts = new Map<string, number>()
  for (const s of sources) counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
  const out = new Map<string, string>()
  for (const s of sources) {
    out.set(
      s.plugin.id,
      (counts.get(s.name) ?? 0) > 1 ? `${s.name}-${marketplaceOf(s.plugin.id)}` : s.name
    )
  }
  return out
}

/** The keys a stub keeps: it has a name and nothing that does anything. */
const STUB_MANIFEST_KEYS = ['name', 'version', 'description'] as const

async function writePlugin(dir: string, name: string, source: Source): Promise<void> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  const manifest: Record<string, unknown> = { ...source.manifest, name }
  if (source.version) manifest['version'] = source.version
  if (source.description) manifest['description'] = source.description
  // Only the allow-listed keys are ever written.
  const keys = source.stub ? STUB_MANIFEST_KEYS : ALLOWED_MANIFEST_KEYS
  const clean = Object.fromEntries(
    keys.flatMap((k) => (manifest[k] !== undefined ? [[k, manifest[k]]] : []))
  )
  await writeJson(join(dir, '.claude-plugin', 'plugin.json'), clean)
  if (source.stub) return
  for (const entry of await readdir(source.plugin.installPath)) {
    if (UNLINKED_ENTRIES.has(entry)) continue
    await symlink(join(source.plugin.installPath, entry), join(dir, entry))
  }
}

async function writeUserWrapper(
  dir: string,
  home: string,
  skills: readonly string[] | null
): Promise<void> {
  await mkdir(join(dir, '.claude-plugin'), { recursive: true })
  await writeJson(join(dir, '.claude-plugin', 'plugin.json'), { name: 'user' })
  const skillsDir = join(home, '.claude', 'skills')
  if (skills === null) {
    if (await exists(skillsDir)) await symlink(skillsDir, join(dir, 'skills'))
  } else {
    // Some skills are off: a real folder with a link to each remaining skill (a symlinked skill folder loads).
    await mkdir(join(dir, 'skills'))
    for (const name of skills) await symlink(join(skillsDir, name), join(dir, 'skills', name))
  }
  const commands = join(home, '.claude', 'commands')
  if (await exists(commands)) await symlink(commands, join(dir, 'commands'))
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf8')
}
