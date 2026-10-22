import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  parsePluginList,
  PluginViewService,
  repoSettingsWarnings,
  type InstalledPlugin
} from '../../../src/main/plugins/plugin-view'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-plugin-view-')

interface Fixture {
  home: string
  base: string
  cache: string
}

function fixture(): Fixture {
  const root = dir()
  mkdirSync(join(root, 'home', '.claude'), { recursive: true })
  mkdirSync(join(root, 'cache'), { recursive: true })
  return {
    home: join(root, 'home'),
    base: join(root, 'userData', 'agent-plugins'),
    cache: join(root, 'cache')
  }
}

/** An installed plugin with commands, skills, agents, hooks, MCP definitions and the LSP and settings files that must NOT reach an agent. */
function install(
  fx: Fixture,
  id: string,
  extra: Partial<InstalledPlugin> = {},
  manifest: Record<string, unknown> = {}
): InstalledPlugin {
  const name = id.split('@')[0] as string
  const market = id.split('@')[1] ?? 'm'
  const version = (extra.version ?? '1.0.0') as string
  const path = join(fx.cache, market, name, version)
  mkdirSync(join(path, '.claude-plugin'), { recursive: true })
  writeFileSync(
    join(path, '.claude-plugin', 'plugin.json'),
    JSON.stringify({
      name,
      version,
      description: `${name} plugin`,
      author: { name: 'x' },
      hooks: { SessionStart: [] },
      mcpServers: { s: { command: 'x' } },
      lspServers: {},
      ...manifest
    })
  )
  for (const sub of ['commands', 'skills', 'agents']) {
    mkdirSync(join(path, sub), { recursive: true })
    writeFileSync(join(path, sub, 'one.md'), '# one')
  }
  mkdirSync(join(path, 'hooks'), { recursive: true })
  writeFileSync(join(path, 'hooks', 'hooks.json'), '{}')
  mkdirSync(join(path, 'scripts'), { recursive: true })
  writeFileSync(join(path, 'scripts', 'on-start.sh'), 'echo hi')
  writeFileSync(join(path, '.mcp.json'), '{}')
  writeFileSync(join(path, '.lsp.json'), '{}')
  writeFileSync(join(path, 'settings.json'), '{}')
  return {
    id,
    scope: 'user',
    enabled: true,
    version,
    installPath: path,
    lastUpdated: '2026-01-01T00:00:00Z',
    ...extra
  }
}

function service(
  fx: Fixture,
  list: () => InstalledPlugin[],
  extra: { keep?: number; warn?: (m: string, ...r: unknown[]) => void } = {}
): PluginViewService {
  return new PluginViewService({
    baseDir: fx.base,
    listInstalled: () => Promise.resolve(list()),
    getHome: () => fx.home,
    log: { warn: extra.warn ?? vi.fn() },
    ...(extra.keep ? { keep: extra.keep } : {})
  })
}

function repoWith(fx: Fixture, name: string, settings: unknown): string {
  const repo = join(fx.home, '..', 'repos', name)
  mkdirSync(join(repo, '.claude'), { recursive: true })
  writeFileSync(
    join(repo, '.claude', 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings)
  )
  return repo
}

const views = (fx: Fixture): string[] =>
  existsSync(fx.base) ? readdirSync(fx.base).filter((n) => !n.startsWith('.tmp-')) : []

describe('sanitized plugins', () => {
  it('keeps hooks/ and .mcp.json, still has no .lsp.json or settings.json, and links the rest of the plugin', async () => {
    const fx = fixture()
    const plugin = install(fx, 'superpowers@official')
    const view = await service(fx, () => [plugin]).current()
    expect(view).toBeDefined()
    const out = join(view as string, 'superpowers')
    expect(readdirSync(out).sort()).toEqual([
      '.claude-plugin',
      '.mcp.json',
      'agents',
      'commands',
      'hooks',
      'scripts',
      'skills'
    ])
    expect(readFileSync(join(out, 'hooks', 'hooks.json'), 'utf8')).toBe('{}')
    expect(readFileSync(join(out, '.mcp.json'), 'utf8')).toBe('{}')
    for (const banned of ['.lsp.json', 'settings.json']) {
      expect(existsSync(join(out, banned))).toBe(false)
    }
    expect(lstatSync(join(out, 'skills')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(out, 'hooks')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(out, 'commands'))).toBe(join(plugin.installPath, 'commands'))
    // A hook command that runs ${CLAUDE_PLUGIN_ROOT}/scripts/... finds its script inside the view.
    expect(readFileSync(join(out, 'scripts', 'on-start.sh'), 'utf8')).toBe('echo hi')
    expect(readFileSync(join(out, 'skills', 'one.md'), 'utf8')).toBe('# one')
  })

  it('keeps name, version, description, hooks and mcpServers in plugin.json, and drops lspServers and the rest', async () => {
    const fx = fixture()
    const view = await service(fx, () => [
      install(fx, 'p@m', {}, { settings: { permissions: { allow: ['Bash'] } } })
    ]).current()
    const manifest = JSON.parse(
      readFileSync(join(view as string, 'p', '.claude-plugin', 'plugin.json'), 'utf8')
    ) as Record<string, unknown>
    expect(Object.keys(manifest).sort()).toEqual([
      'description',
      'hooks',
      'mcpServers',
      'name',
      'version'
    ])
    expect(manifest).toEqual({
      name: 'p',
      version: '1.0.0',
      description: 'p plugin',
      hooks: { SessionStart: [] },
      mcpServers: { s: { command: 'x' } }
    })
    expect(manifest).not.toHaveProperty('lspServers')
    expect(manifest).not.toHaveProperty('settings')
    expect(manifest).not.toHaveProperty('author')
  })

  it('links only the entries that exist', async () => {
    const fx = fixture()
    const plugin = install(fx, 'lean@m')
    const { rmSync } = await import('node:fs')
    for (const gone of ['agents', 'commands', 'hooks', 'scripts', '.mcp.json']) {
      rmSync(join(plugin.installPath, gone), { recursive: true })
    }
    const view = await service(fx, () => [plugin]).current()
    expect(readdirSync(join(view as string, 'lean')).sort()).toEqual(['.claude-plugin', 'skills'])
  })

  it('lists the plugins of the view with their folder name and manifest', async () => {
    const fx = fixture()
    const list = [install(fx, 'tools@alpha'), install(fx, 'tools@beta'), install(fx, 'solo@m')]
    const sources = await service(fx, () => list).sources()
    expect(sources.map((s) => s.folder).sort()).toEqual(['solo', 'tools-alpha', 'tools-beta'])
    expect(sources.find((s) => s.id === 'solo@m')?.manifest['mcpServers']).toEqual({
      s: { command: 'x' }
    })
  })

  it('suffixes the marketplace when two plugins share a name', async () => {
    const fx = fixture()
    const list = [install(fx, 'tools@alpha'), install(fx, 'tools@beta')]
    const view = await service(fx, () => list).current()
    const names = readdirSync(view as string).filter((n) => n !== 'user')
    expect(names.sort()).toEqual(['tools-alpha', 'tools-beta'])
    const manifest = JSON.parse(
      readFileSync(join(view as string, 'tools-beta', '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { name: string }
    expect(manifest.name).toBe('tools-beta')
  })
})

describe('sources', () => {
  it('dedupes by id keeping the latest lastUpdated', async () => {
    const fx = fixture()
    const old = install(fx, 'dup@m', { version: '1.0.0', lastUpdated: '2026-01-01T00:00:00Z' })
    const fresh = install(fx, 'dup@m', { version: '2.0.0', lastUpdated: '2026-06-01T00:00:00Z' })
    const view = await service(fx, () => [old, fresh]).current()
    const manifest = JSON.parse(
      readFileSync(join(view as string, 'dup', '.claude-plugin', 'plugin.json'), 'utf8')
    ) as { version: string }
    expect(manifest.version).toBe('2.0.0')
    expect(readdirSync(view as string).filter((n) => n !== 'user')).toEqual(['dup'])
  })

  it('leaves out disabled and non-user-scope plugins', async () => {
    const fx = fixture()
    const list = [
      install(fx, 'on@m'),
      install(fx, 'off@m', { enabled: false }),
      install(fx, 'proj@m', { scope: 'project' }),
      install(fx, 'local@m', { scope: 'local' })
    ]
    const view = await service(fx, () => list).current()
    expect(readdirSync(view as string).sort()).toEqual(['on', 'user'])
  })

  it('parses both list shapes and drops malformed entries', () => {
    const entry = { id: 'a@m', scope: 'user', enabled: true, installPath: '/x', version: '1' }
    expect(parsePluginList(JSON.stringify([entry, { id: 'no-path' }, 5]))).toHaveLength(1)
    expect(parsePluginList(JSON.stringify({ installed: [entry], available: [] }))).toHaveLength(1)
    expect(parsePluginList('{}')).toEqual([])
  })
})

describe('repository enabledPlugins', () => {
  it('includes shadow copies of installed repo plugins, even when disabled at user scope', async () => {
    const fx = fixture()
    const list = [
      install(fx, 'on@m'),
      install(fx, 'warp@m', { enabled: false }),
      install(fx, 'proj@m', { scope: 'project', enabled: true }),
      install(fx, 'plain@m', { enabled: false })
    ]
    const repo = repoWith(fx, 'a', {
      enabledPlugins: { 'warp@m': true, 'proj@m': true, 'missing@m': true, 'plain@m': false }
    })
    const view = (await service(fx, () => list).current([repo])) as string
    expect(readdirSync(view).sort()).toEqual(['on', 'proj', 'user', 'warp'])
    expect(existsSync(join(view, 'warp', 'hooks'))).toBe(true)
    expect(existsSync(join(view, 'warp', '.lsp.json'))).toBe(false)
    expect(existsSync(join(view, 'warp', 'skills'))).toBe(true)
  })

  it('tolerates a missing or invalid settings file and gives a different view per shadow set', async () => {
    const fx = fixture()
    const list = [install(fx, 'warp@m', { enabled: false })]
    const broken = repoWith(fx, 'broken', '{ not json')
    const missing = join(fx.home, 'nowhere')
    const svc = service(fx, () => list)
    const none = await svc.current([broken, missing])
    expect(readdirSync(none as string)).toEqual(['user'])
    const shadowed = await svc.current([repoWith(fx, 'ok', { enabledPlugins: { 'warp@m': true } })])
    expect(shadowed).not.toBe(none)
  })

  it('repoSettingsWarnings reports hooks and enabled plugin ids, read-only', async () => {
    const fx = fixture()
    const repo = repoWith(fx, 'w', {
      hooks: { SessionStart: [{ hooks: [] }] },
      enabledPlugins: { 'a@m': true, 'b@m': false }
    })
    const before = readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')
    expect(await repoSettingsWarnings(repo)).toEqual({ hooks: true, enabledPlugins: ['a@m'] })
    expect(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8')).toBe(before)
    expect(await repoSettingsWarnings(join(fx.home, 'nowhere'))).toEqual({
      hooks: false,
      enabledPlugins: []
    })
    expect(await repoSettingsWarnings(repoWith(fx, 'bad', '[1'))).toEqual({
      hooks: false,
      enabledPlugins: []
    })
  })
})

describe('the user wrapper', () => {
  it('names the plugin "user" and links ~/.claude/skills and ~/.claude/commands when present', async () => {
    const fx = fixture()
    mkdirSync(join(fx.home, '.claude', 'skills', 'mine'), { recursive: true })
    mkdirSync(join(fx.home, '.claude', 'commands'), { recursive: true })
    const view = (await service(fx, () => []).current()) as string
    const wrapper = join(view, 'user')
    expect(
      JSON.parse(readFileSync(join(wrapper, '.claude-plugin', 'plugin.json'), 'utf8'))
    ).toEqual({
      name: 'user'
    })
    expect(readlinkSync(join(wrapper, 'skills'))).toBe(join(fx.home, '.claude', 'skills'))
    expect(readlinkSync(join(wrapper, 'commands'))).toBe(join(fx.home, '.claude', 'commands'))
    expect(existsSync(join(wrapper, 'skills', 'mine'))).toBe(true)
  })

  it('omits links for folders that do not exist', async () => {
    const fx = fixture()
    const view = (await service(fx, () => []).current()) as string
    expect(readdirSync(join(view, 'user'))).toEqual(['.claude-plugin'])
  })
})

describe('hash', () => {
  it('is stable across runs and services', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m'), install(fx, 'b@m')]
    const first = await service(fx, () => list).current()
    const second = await service(fx, () => [...list].reverse()).current()
    expect(second).toBe(first)
    expect(views(fx)).toHaveLength(1)
  })

  it('changes when a version, an install path, a manifest mtime, or a linked folder changes', async () => {
    const fx = fixture()
    const a = install(fx, 'a@m')
    const base = (await service(fx, () => [a]).current()) as string
    const bumped = (await service(fx, () => [
      install(fx, 'a@m', { version: '1.1.0' })
    ]).current()) as string
    expect(bumped).not.toBe(base)
    const moved = (await service(fx, () => [
      { ...a, installPath: install(fx, 'a@other').installPath }
    ]).current()) as string
    expect(moved).not.toBe(base)
    const manifest = join(a.installPath, '.claude-plugin', 'plugin.json')
    utimesSync(manifest, new Date(2030, 1, 1), new Date(2030, 1, 1))
    expect(await service(fx, () => [a]).current()).not.toBe(base)

    const elsewhere = join(dir(), 'elsewhere-skills')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(fx.home, '.claude', 'skills'))
    expect(realpathSync(join(fx.home, '.claude', 'skills'))).toBe(realpathSync(elsewhere))
    expect(await service(fx, () => [a]).current()).not.toBe(base)
  })
})

describe('swap and cleanup', () => {
  it('builds in .tmp-* and leaves only the hash folder', async () => {
    const fx = fixture()
    const view = (await service(fx, () => [install(fx, 'a@m')]).current()) as string
    expect(readdirSync(fx.base)).toEqual([view.slice(fx.base.length + 1)])
  })

  it('reuses an existing hash folder without rebuilding', async () => {
    const fx = fixture()
    const plugin = install(fx, 'a@m')
    const svc = service(fx, () => [plugin])
    const view = (await svc.current()) as string
    writeFileSync(join(view, 'marker'), 'x')
    expect(await svc.current()).toBe(view)
    expect(await service(fx, () => [plugin]).current()).toBe(view)
    expect(existsSync(join(view, 'marker'))).toBe(true)
  })

  it('keeps the newest 3 views and the current one', async () => {
    const fx = fixture()
    let version = 0
    const svc = service(fx, () => [install(fx, 'a@m', { version: `1.0.${version}` })], { keep: 3 })
    const made: string[] = []
    for (version = 0; version < 5; version++) {
      const view = (await svc.rebuild()) as string
      // Distinct, increasing mtimes so "newest" is unambiguous.
      utimesSync(view, new Date(2026, 0, 1 + version), new Date(2026, 0, 1 + version))
      made.push(view)
    }
    expect(views(fx).sort()).toEqual(
      made
        .slice(2)
        .map((v) => v.slice(fx.base.length + 1))
        .sort()
    )
  })

  it('sweeps stale .tmp-* folders on the first build', async () => {
    const fx = fixture()
    mkdirSync(join(fx.base, '.tmp-dead', 'x'), { recursive: true })
    await service(fx, () => []).current()
    expect(readdirSync(fx.base).some((n) => n.startsWith('.tmp-'))).toBe(false)
  })

  it('returns undefined and warns when the view cannot be built', async () => {
    const fx = fixture()
    const warn = vi.fn()
    const svc = new PluginViewService({
      baseDir: fx.base,
      listInstalled: () => Promise.reject(new Error('claude missing')),
      getHome: () => fx.home,
      log: { warn }
    })
    expect(await svc.current()).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('does not build after dispose', async () => {
    const fx = fixture()
    const svc = service(fx, () => [install(fx, 'a@m')])
    await svc.dispose()
    expect(await svc.current()).toBeUndefined()
    expect(existsSync(fx.base)).toBe(false)
  })
})

describe('the selection per role (spec 009)', () => {
  type Role = 'brain' | 'workers'
  const offFor =
    (selection: Partial<Record<Role, string[]>>) =>
    (role: Role): ReadonlySet<string> =>
      new Set(selection[role] ?? [])

  function roleService(
    fx: Fixture,
    list: () => InstalledPlugin[],
    selection: Partial<Record<Role, string[]>>,
    extra: { onChanged?: (dir: string) => void } = {}
  ): PluginViewService {
    return new PluginViewService({
      baseDir: fx.base,
      listInstalled: () => Promise.resolve(list()),
      getHome: () => fx.home,
      log: { warn: vi.fn() },
      off: offFor(selection),
      ...extra
    })
  }

  const folders = (view: string | undefined): string[] =>
    readdirSync(view as string)
      .filter((n) => n !== 'user')
      .sort()

  function makeSkills(fx: Fixture, names: string[]): void {
    for (const name of names) {
      mkdirSync(join(fx.home, '.claude', 'skills', name), { recursive: true })
      writeFileSync(
        join(fx.home, '.claude', 'skills', name, 'SKILL.md'),
        `---\nname: ${name}\n---\n`
      )
    }
  }

  it('leaves a plugin out of the folder of the role that switched it off, and keeps it for the other', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m'), install(fx, 'b@m')]
    const svc = roleService(fx, () => list, { workers: ['plugin:a@m'] })
    expect(folders(await svc.current([], 'workers'))).toEqual(['b'])
    expect(folders(await svc.current([], 'brain'))).toEqual(['a', 'b'])
  })

  it('gives both roles one folder when their selections agree, and none of the plugins when all are off', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m')]
    const same = roleService(fx, () => list, {})
    expect(await same.current([], 'brain')).toBe(await same.current([], 'workers'))
    const off = roleService(fx, () => list, { brain: ['plugin:a@m'] })
    expect(folders(await off.current([], 'brain'))).toEqual([])
    expect(await off.current([], 'brain')).not.toBe(await off.current([], 'workers'))
  })

  it('lists the plugins of the role in sources, and all of them without a role', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m'), install(fx, 'b@m')]
    const svc = roleService(fx, () => list, { brain: ['plugin:b@m'] })
    expect((await svc.sources([], 'brain')).map((s) => s.id)).toEqual(['a@m'])
    expect((await svc.sources([], 'workers')).map((s) => s.id)).toEqual(['a@m', 'b@m'])
    expect((await svc.sources([])).map((s) => s.id)).toEqual(['a@m', 'b@m'])
  })

  it('applies a changed selection to the next call', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m')]
    let selection: Partial<Record<Role, string[]>> = {}
    const svc = new PluginViewService({
      baseDir: fx.base,
      listInstalled: () => Promise.resolve(list),
      getHome: () => fx.home,
      log: { warn: vi.fn() },
      off: (role) => new Set(selection[role] ?? [])
    })
    expect(folders(await svc.current([], 'workers'))).toEqual(['a'])
    selection = { workers: ['plugin:a@m'] }
    expect(folders(await svc.current([], 'workers'))).toEqual([])
    selection = {}
    expect(folders(await svc.current([], 'workers'))).toEqual(['a'])
  })

  it('writes a manifest-only stub for an off plugin that a repository enables, so the raw plugin still does not load', async () => {
    const fx = fixture()
    const plugin = install(fx, 'a@m')
    const repo = repoWith(fx, 'api', { enabledPlugins: { 'a@m': true } })
    const svc = roleService(fx, () => [plugin], { workers: ['plugin:a@m'] })
    const worker = await svc.current([repo], 'workers')
    expect(folders(worker)).toEqual(['a'])
    expect(readdirSync(join(worker as string, 'a')).sort()).toEqual(['.claude-plugin'])
    expect(
      JSON.parse(readFileSync(join(worker as string, 'a', '.claude-plugin', 'plugin.json'), 'utf8'))
    ).toEqual({ name: 'a', version: '1.0.0', description: 'a plugin' })
    // The stub is not a plugin of the view: nobody reads its hooks or servers.
    expect(await svc.sources([repo], 'workers')).toEqual([])
    // The brain still has the real thing.
    expect(
      readdirSync(join((await svc.current([repo], 'brain')) as string, 'a')).length
    ).toBeGreaterThan(1)
  })

  it('links ~/.claude/skills as one link while no skill is off', async () => {
    const fx = fixture()
    makeSkills(fx, ['one', 'two'])
    const svc = roleService(fx, () => [], { workers: ['skill:gone'] })
    const view = (await svc.current([], 'workers')) as string
    expect(readlinkSync(join(view, 'user', 'skills'))).toBe(join(fx.home, '.claude', 'skills'))
  })

  it('builds a skills folder of links without the skills that are off, for that role only', async () => {
    const fx = fixture()
    makeSkills(fx, ['one', 'two', 'three'])
    const svc = roleService(fx, () => [], { workers: ['skill:two'] })
    const worker = (await svc.current([], 'workers')) as string
    const skills = join(worker, 'user', 'skills')
    expect(lstatSync(skills).isDirectory()).toBe(true)
    expect(lstatSync(skills).isSymbolicLink()).toBe(false)
    expect(readdirSync(skills).sort()).toEqual(['one', 'three'])
    expect(readlinkSync(join(skills, 'one'))).toBe(join(fx.home, '.claude', 'skills', 'one'))
    expect(readFileSync(join(skills, 'three', 'SKILL.md'), 'utf8')).toContain('three')
    const brain = (await svc.current([], 'brain')) as string
    expect(readdirSync(join(brain, 'user', 'skills')).sort()).toEqual(['one', 'three', 'two'])
    expect(brain).not.toBe(worker)
  })

  it('shows a skill that is added later in the next view, and keeps commands linked as they were', async () => {
    const fx = fixture()
    makeSkills(fx, ['one', 'two'])
    mkdirSync(join(fx.home, '.claude', 'commands'), { recursive: true })
    const svc = roleService(fx, () => [], { workers: ['skill:two'] })
    const first = (await svc.current([], 'workers')) as string
    expect(readdirSync(join(first, 'user', 'skills'))).toEqual(['one'])
    makeSkills(fx, ['fresh'])
    const second = (await svc.current([], 'workers')) as string
    expect(second).not.toBe(first)
    expect(readdirSync(join(second, 'user', 'skills')).sort()).toEqual(['fresh', 'one'])
    expect(readlinkSync(join(second, 'user', 'commands'))).toBe(
      join(fx.home, '.claude', 'commands')
    )
  })

  it('tells the pages about a changed workers view only, not about the brain’s', async () => {
    const fx = fixture()
    const list = [install(fx, 'a@m')]
    const onChanged = vi.fn()
    let selection: Partial<Record<Role, string[]>> = {}
    const svc = new PluginViewService({
      baseDir: fx.base,
      listInstalled: () => Promise.resolve(list),
      getHome: () => fx.home,
      log: { warn: vi.fn() },
      off: (role) => new Set(selection[role] ?? []),
      onChanged
    })
    await svc.current([], 'workers')
    await svc.current([], 'brain')
    expect(onChanged).not.toHaveBeenCalled()
    selection = { brain: ['plugin:a@m'] }
    await svc.current([], 'brain')
    expect(onChanged).not.toHaveBeenCalled()
    selection = { brain: ['plugin:a@m'], workers: ['plugin:a@m'] }
    await svc.current([], 'workers')
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('keeps the other role’s folder when one role builds a new view', async () => {
    const fx = fixture()
    let version = 0
    const svc = new PluginViewService({
      baseDir: fx.base,
      listInstalled: () => Promise.resolve([install(fx, 'a@m', { version: `1.0.${version}` })]),
      getHome: () => fx.home,
      log: { warn: vi.fn() },
      off: (role) => new Set(role === 'brain' ? ['plugin:a@m'] : [])
    })
    const brain = (await svc.current([], 'brain')) as string
    const worker = (await svc.current([], 'workers')) as string
    expect(brain).not.toBe(worker)
    for (version = 1; version <= 2; version++) await svc.rebuild()
    expect(existsSync(brain)).toBe(true)
  })
})
