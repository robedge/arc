import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexPersonalServer, CodexStartOptions } from '../../../src/main/agents/agent-adapter'
import { pluginServerName } from '../../../src/main/personal/claude-user-config'
import { applyCodexMcp, PersonalConfigService } from '../../../src/main/personal/personal-config'
import { PluginViewService, type PluginViewSource } from '../../../src/main/plugins/plugin-view'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-personal-')

const SECRET = 'sk-user-secret-value'

interface Fixture {
  home: string
  base: string
  repo: string
  arcConfig: string
  warn: ReturnType<typeof vi.fn<(message: string, ...rest: unknown[]) => void>>
}

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function fixture(): Fixture {
  const root = dir()
  const home = join(root, 'home')
  const repo = join(root, 'repos', 'api')
  mkdirSync(join(home, '.claude'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  const arcConfig = join(root, 'userData', 'mcp', 'brain.json')
  write(arcConfig, {
    mcpServers: {
      arc: {
        type: 'http',
        url: 'http://127.0.0.1:4000/mcp',
        headers: { Authorization: 'Bearer t' }
      }
    }
  })
  return {
    home,
    base: join(root, 'userData', 'agent-config'),
    repo,
    arcConfig,
    warn: vi.fn<(message: string, ...rest: unknown[]) => void>()
  }
}

function service(
  fx: Fixture,
  plugins: PluginViewSource[] = [],
  extra: Partial<ConstructorParameters<typeof PersonalConfigService>[0]> = {}
): PersonalConfigService {
  return new PersonalConfigService({
    baseDir: fx.base,
    getHome: () => fx.home,
    plugins: { sources: () => Promise.resolve(plugins) },
    log: { warn: fx.warn },
    ...extra
  })
}

function plugin(
  name: string,
  files: { mcp?: unknown; manifest?: Record<string, unknown> } = {}
): PluginViewSource {
  const installPath = join(dir(), 'cache', name)
  mkdirSync(installPath, { recursive: true })
  if (files.mcp !== undefined) write(join(installPath, '.mcp.json'), files.mcp)
  return {
    id: `${name}@m`,
    folder: name,
    installPath,
    manifest: { name, ...files.manifest }
  }
}

const read = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>

const USER_SETTINGS = {
  permissions: { allow: ['Bash(git push:*)'], deny: ['Read(.env)'] },
  env: { ANTHROPIC_API_KEY: SECRET },
  statusLine: { type: 'command', command: 'echo hi' },
  enabledPlugins: { 'x@y': true },
  disableAllHooks: false,
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'touch /tmp/started' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'check.sh' }] }]
  }
}

describe('hooks', () => {
  it('writes a settings file with only the hooks, verbatim', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), USER_SETTINGS)
    const files = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(files.hooksSettingsPath).toBe(
      join(fx.base, files.hooksSettingsPath!.split('/').at(-2)!, 'hooks.settings.json')
    )
    expect(read(files.hooksSettingsPath!)).toEqual({ hooks: USER_SETTINGS.hooks })
  })

  it('drops permissions, env and every other key, in the file and anywhere in the output folder', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), USER_SETTINGS)
    const files = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    const settings = read(files.hooksSettingsPath!)
    expect(Object.keys(settings)).toEqual(['hooks'])
    for (const banned of [
      'permissions',
      'env',
      'statusLine',
      'enabledPlugins',
      'disableAllHooks'
    ]) {
      expect(settings).not.toHaveProperty(banned)
    }
    const everything = readdirSync(join(files.hooksSettingsPath!, '..'))
      .map((f) => readFileSync(join(files.hooksSettingsPath!, '..', f), 'utf8'))
      .join('\n')
    expect(everything).not.toContain('git push')
    expect(everything).not.toContain(SECRET)
  })

  it('has no hooks file when the user has no hooks, or no settings at all', async () => {
    const fx = fixture()
    expect((await service(fx).claude({ repoPaths: [] })).hooksSettingsPath).toBeUndefined()
    write(join(fx.home, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash'] },
      hooks: {}
    })
    const files = await service(fx).claude({ repoPaths: [] })
    expect(files.hooksSettingsPath).toBeUndefined()
    expect(existsSync(join(files.mcpConfigPath, '..', 'hooks.settings.json'))).toBe(false)
  })

  it('survives a broken settings file', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), '{ not json')
    expect((await service(fx).claude({ repoPaths: [] })).hooksSettingsPath).toBeUndefined()
  })
})

describe('MCP servers', () => {
  it('merges the bridge, the user, local scope, the plugins and the repository', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), {
      mcpServers: { figma: { command: 'npx', args: ['figma'], env: { TOKEN: SECRET } } },
      projects: {
        [fx.repo]: { mcpServers: { scratch: { command: 'scratch' } } },
        '/elsewhere': { mcpServers: { other: { command: 'other' } } }
      },
      oauthAccount: { emailAddress: 'u@example.com' }
    })
    write(join(fx.repo, '.mcp.json'), { mcpServers: { shared: { url: 'https://repo.test/mcp' } } })
    const warp = plugin('warp', { mcp: { mcpServers: { spy: { command: 'warp-spy' } } } })
    const inline = plugin('inline', {
      manifest: { mcpServers: { tool: { command: 'inline-tool' } } }
    })
    const files = await service(fx, [warp, inline]).claude({
      repoPaths: [fx.repo],
      arcConfigPath: fx.arcConfig
    })
    const servers = read(files.mcpConfigPath)['mcpServers'] as Record<
      string,
      Record<string, unknown>
    >
    expect(Object.keys(servers).sort()).toEqual(
      ['arc', 'figma', 'plugin_inline_tool', 'plugin_warp_spy', 'scratch', 'shared'].sort()
    )
    expect(servers['figma']).toEqual({ command: 'npx', args: ['figma'], env: { TOKEN: SECRET } })
    expect(servers['plugin_warp_spy']).toEqual({ command: 'warp-spy' })
    expect(servers['arc']).toMatchObject({ url: 'http://127.0.0.1:4000/mcp' })
    expect(servers).not.toHaveProperty('other') // another project's local scope
    expect(JSON.stringify(servers)).not.toContain('emailAddress')
  })

  it('names plugin servers plugin_<plugin>_<server> and expands ${CLAUDE_PLUGIN_ROOT}', async () => {
    const fx = fixture()
    const p = plugin('db-tools', {
      mcp: {
        'my.server': {
          command: '${CLAUDE_PLUGIN_ROOT}/bin/serve',
          args: ['--config', '${CLAUDE_PLUGIN_ROOT}/conf.json'],
          env: { HOME_DIR: '${HOME}' }
        }
      }
    })
    expect(pluginServerName('db-tools', 'my.server')).toBe('plugin_db-tools_my_server')
    const files = await service(fx, [p]).claude({ repoPaths: [] })
    const servers = read(files.mcpConfigPath)['mcpServers'] as Record<string, unknown>
    expect(servers['plugin_db-tools_my_server']).toEqual({
      command: `${p.installPath}/bin/serve`,
      args: ['--config', `${p.installPath}/conf.json`],
      // Other variables are left for Claude to expand.
      env: { HOME_DIR: '${HOME}' }
    })
  })

  it('reads a plugin manifest mcpServers path, and skips a server that needs user_config with a log line', async () => {
    const fx = fixture()
    const p = plugin('cfg', { manifest: { mcpServers: './servers.json' } })
    write(join(p.installPath, 'servers.json'), {
      mcpServers: {
        ok: { command: 'ok' },
        needs: { command: 'run', env: { KEY: '${user_config.api_key}' } }
      }
    })
    const files = await service(fx, [p]).claude({ repoPaths: [] })
    const servers = read(files.mcpConfigPath)['mcpServers'] as Record<string, unknown>
    expect(Object.keys(servers)).toEqual(['plugin_cfg_ok'])
    expect(fx.warn).toHaveBeenCalledTimes(1)
    expect(String(fx.warn.mock.calls[0]?.[0])).toContain('needs')
    expect(String(fx.warn.mock.calls[0]?.[0])).toContain('user_config')
  })

  it('lets the bridge win a name clash with the user, the repository and a plugin', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), { mcpServers: { arc: { command: 'imposter' } } })
    write(join(fx.repo, '.mcp.json'), { arc: { command: 'imposter-2' } })
    const files = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    const servers = read(files.mcpConfigPath)['mcpServers'] as Record<
      string,
      Record<string, unknown>
    >
    expect(servers['arc']).toMatchObject({ type: 'http', url: 'http://127.0.0.1:4000/mcp' })
    expect(servers['arc']).not.toHaveProperty('command')
  })

  it('prefers local scope over the repository file over user scope for the same name', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), {
      mcpServers: { a: { command: 'user-a' }, b: { command: 'user-b' }, c: { command: 'user-c' } },
      projects: { [fx.repo]: { mcpServers: { a: { command: 'local-a' } } } }
    })
    write(join(fx.repo, '.mcp.json'), {
      mcpServers: { a: { command: 'repo-a' }, b: { command: 'repo-b' } }
    })
    const files = await service(fx).claude({ repoPaths: [fx.repo] })
    const servers = read(files.mcpConfigPath)['mcpServers'] as Record<string, { command: string }>
    expect(servers['a']?.command).toBe('local-a')
    expect(servers['b']?.command).toBe('repo-b')
    expect(servers['c']?.command).toBe('user-c')
  })

  it('works without a bridge file (the command probe) and rejects when the bridge file is unusable', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), { mcpServers: { figma: { command: 'f' } } })
    const probe = await service(fx).claude({ repoPaths: [] })
    expect(Object.keys(read(probe.mcpConfigPath)['mcpServers'] as object)).toEqual(['figma'])
    await expect(
      service(fx).claude({ repoPaths: [], arcConfigPath: join(fx.base, 'nope') })
    ).rejects.toThrow()
    write(join(fx.base, 'empty.json'), { mcpServers: {} })
    await expect(
      service(fx).claude({ repoPaths: [], arcConfigPath: join(fx.base, 'empty.json') })
    ).rejects.toThrow(/no arc server/)
  })

  it('ignores a broken ~/.claude.json and a broken .mcp.json', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), '{ nope')
    write(join(fx.repo, '.mcp.json'), '[1,2')
    const files = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(Object.keys(read(files.mcpConfigPath)['mcpServers'] as object)).toEqual(['arc'])
  })

  it('uses the plugins of the real plugin view, for the repositories it is asked about', async () => {
    const fx = fixture()
    const installed = join(dir(), 'cache', 'warp', '1.0.0')
    write(join(installed, '.claude-plugin', 'plugin.json'), { name: 'warp', version: '1.0.0' })
    write(join(installed, '.mcp.json'), {
      mcpServers: { spy: { command: '${CLAUDE_PLUGIN_ROOT}/spy' } }
    })
    const view = new PluginViewService({
      baseDir: join(dir(), 'agent-plugins'),
      getHome: () => fx.home,
      listInstalled: () =>
        Promise.resolve([
          {
            id: 'warp@m',
            scope: 'user',
            enabled: true,
            version: '1.0.0',
            installPath: installed,
            lastUpdated: '2026-01-01T00:00:00Z'
          }
        ])
    })
    const files = await service(fx, [], { plugins: view }).claude({ repoPaths: [fx.repo] })
    expect(read(files.mcpConfigPath)['mcpServers']).toEqual({
      plugin_warp_spy: { command: `${installed}/spy` }
    })
  })
})

describe('files', () => {
  it('writes the output folder with mode 0700 and both files with mode 0600', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), USER_SETTINGS)
    const files = await service(fx).claude({ repoPaths: [], arcConfigPath: fx.arcConfig })
    const folder = join(files.mcpConfigPath, '..')
    expect(statSync(folder).mode & 0o777).toBe(0o700)
    expect(statSync(files.mcpConfigPath).mode & 0o777).toBe(0o600)
    expect(statSync(files.hooksSettingsPath!).mode & 0o777).toBe(0o600)
    expect(readdirSync(folder).sort()).toEqual(['hooks.settings.json', 'mcp.json'])
  })

  it('never writes to the user configuration', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), USER_SETTINGS)
    write(join(fx.home, '.claude.json'), { mcpServers: { figma: { command: 'f' } } })
    const paths = [join(fx.home, '.claude', 'settings.json'), join(fx.home, '.claude.json')]
    const past = new Date(2020, 0, 1)
    for (const p of paths) utimesSync(p, past, past)
    const before = paths.map((p) => [readFileSync(p, 'utf8'), statSync(p).mtimeMs])
    await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(paths.map((p) => [readFileSync(p, 'utf8'), statSync(p).mtimeMs])).toEqual(before)
    expect(readdirSync(fx.home).sort()).toEqual(['.claude', '.claude.json'])
  })

  it('never logs a value of the user configuration', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude.json'), {
      mcpServers: { figma: { command: 'npx', env: { TOKEN: SECRET } } }
    })
    const p = plugin('cfg', { mcp: { needs: { env: { KEY: '${user_config.k}', S: SECRET } } } })
    await service(fx, [p]).claude({ repoPaths: [] })
    expect(JSON.stringify(fx.warn.mock.calls)).not.toContain(SECRET)
  })

  it('reuses the folder for the same content and makes a new one when anything changes', async () => {
    const fx = fixture()
    const first = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    const again = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(again).toEqual(first)
    write(join(fx.home, '.claude.json'), { mcpServers: { figma: { command: 'f' } } })
    const changed = await service(fx).claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(changed.mcpConfigPath).not.toBe(first.mcpConfigPath)
  })

  it('keeps the newest folders and the current one, and sweeps stale .tmp-* folders', async () => {
    const fx = fixture()
    mkdirSync(join(fx.base, '.tmp-dead'), { recursive: true })
    const svc = service(fx, [], { keep: 3 })
    const made: string[] = []
    for (let i = 0; i < 5; i++) {
      write(join(fx.home, '.claude.json'), { mcpServers: { [`s${i}`]: { command: 'c' } } })
      const files = await svc.claude({ repoPaths: [] })
      const folder = join(files.mcpConfigPath, '..')
      utimesSync(folder, new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i))
      made.push(folder)
    }
    const left = readdirSync(fx.base).sort()
    expect(left).toEqual(
      made
        .slice(2)
        .map((f) => f.slice(fx.base.length + 1))
        .sort()
    )
    expect(left.some((n) => n.startsWith('.tmp-'))).toBe(false)
  })
})

describe('Codex MCP servers', () => {
  const server = (name: string, approvalTools: string[] = []): CodexPersonalServer => ({
    name,
    approvalTools
  })

  it('splits the servers by the role’s selection: the ones that are off are disabled, the rest are covered (spec 009)', async () => {
    const fx = fixture()
    const read = vi.fn<(cwd: string) => Promise<CodexPersonalServer[]>>(() =>
      Promise.resolve([server('figma'), server('github'), server('trello')])
    )
    const svc = service(fx, [], {
      codexServers: read,
      off: (role) => new Set(role === 'workers' ? ['codex-mcp:figma', 'codex-mcp:gone'] : [])
    })
    expect(await svc.codexMcp('/r', 'workers')).toEqual({
      servers: [server('github'), server('trello')],
      disabled: ['figma'],
      degraded: false
    })
    expect(await svc.codexMcp('/r', 'brain')).toEqual({
      servers: [server('figma'), server('github'), server('trello')],
      degraded: false
    })
    // Without a role (the Settings listing) nothing is split off; one read served all three.
    expect((await svc.codexMcp('/r')).servers).toHaveLength(3)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('asks for the servers once per folder for a short while, and never returns arc', async () => {
    const fx = fixture()
    const read = vi.fn<(cwd: string) => Promise<CodexPersonalServer[]>>(() =>
      Promise.resolve([server('figma', ['get']), server('arc'), server('github')])
    )
    let now = 1000
    const svc = service(fx, [], { codexServers: read, now: () => now })
    const expected = { servers: [server('figma', ['get']), server('github')], degraded: false }
    expect(await svc.codexMcp('/r')).toEqual(expected)
    expect(await svc.codexMcp('/r')).toEqual(expected)
    expect(read).toHaveBeenCalledTimes(1)
    await svc.codexMcp('/other')
    expect(read).toHaveBeenCalledTimes(2)
    now += 60_000
    await svc.codexMcp('/r')
    expect(read).toHaveBeenCalledTimes(3)
  })

  it('retries a failed read once, and the second answer counts', async () => {
    const fx = fixture()
    const read = vi
      .fn<(cwd: string) => Promise<CodexPersonalServer[]>>()
      .mockRejectedValueOnce(new Error('codex busy'))
      .mockResolvedValueOnce([server('figma')])
    const svc = service(fx, [], { codexServers: read })
    expect(await svc.codexMcp('/r')).toEqual({ servers: [server('figma')], degraded: false })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('is degraded, and not cached, when the read fails twice; it works again at the next start', async () => {
    const fx = fixture()
    const read = vi
      .fn<(cwd: string) => Promise<CodexPersonalServer[]>>()
      .mockRejectedValueOnce(new Error('codex down'))
      .mockRejectedValueOnce(new Error('codex down'))
      .mockResolvedValue([server('figma')])
    const svc = service(fx, [], { codexServers: read })
    expect(await svc.codexMcp('/r')).toEqual({ servers: [], degraded: true })
    expect(read).toHaveBeenCalledTimes(2)
    expect(fx.warn).toHaveBeenCalled()
    expect(await svc.codexMcp('/r')).toEqual({ servers: [server('figma')], degraded: false })
  })

  it('has no servers and is not degraded without a reader', async () => {
    expect(await service(fixture()).codexMcp('/r')).toEqual({ servers: [], degraded: false })
  })
})

describe('applyCodexMcp', () => {
  it('names the servers, lists the tools with their own approval mode, and returns the covered names', () => {
    const codex: CodexStartOptions = {}
    const covered = applyCodexMcp(codex, {
      servers: [
        { name: 'trello', approvalTools: ['trello_update_card'] },
        { name: 'figma', approvalTools: [] }
      ],
      degraded: false
    })
    expect(codex).toEqual({
      personalMcpServers: ['trello', 'figma'],
      personalMcpApprovalTools: { trello: ['trello_update_card'] }
    })
    expect([...covered]).toEqual(['trello', 'figma'])
  })

  it('names the servers the user switched off as disabled, and covers only the ones that run (spec 009)', () => {
    const codex: CodexStartOptions = {}
    const covered = applyCodexMcp(codex, {
      servers: [{ name: 'figma', approvalTools: [] }],
      disabled: ['trello'],
      degraded: false
    })
    expect(codex).toEqual({ personalMcpServers: ['figma'], disabledMcpServers: ['trello'] })
    expect([...covered]).toEqual(['figma'])
  })

  it('leaves the options alone and covers nothing when the servers could not be read', () => {
    const codex: CodexStartOptions = {}
    expect(applyCodexMcp(codex, { servers: [], degraded: true }).size).toBe(0)
    expect(codex).toEqual({})
  })
})

describe('the bypass report and the catalogue the service hands out', () => {
  it('returns the detector’s report, and an empty one without a detector', async () => {
    const report = {
      claudeHookEvents: ['PreToolUse'],
      codexAllowPrefixes: ['cp'],
      codexRulesCovered: 1
    }
    const svc = service(fixture(), [], { bypass: () => Promise.resolve(report) })
    expect(await svc.bypass(['/r'])).toEqual(report)
    expect(await service(fixture()).bypass([])).toEqual({
      claudeHookEvents: [],
      codexAllowPrefixes: [],
      codexRulesCovered: 0
    })
  })
})

describe('the selection per role (spec 009)', () => {
  const offFor =
    (selection: Partial<Record<'brain' | 'workers', string[]>>) =>
    (role: 'brain' | 'workers'): ReadonlySet<string> =>
      new Set(selection[role] ?? [])

  function withServers(fx: Fixture): void {
    write(join(fx.home, '.claude.json'), {
      mcpServers: { figma: { command: 'figma' }, trello: { command: 'trello' } }
    })
    write(join(fx.repo, '.mcp.json'), { mcpServers: { repoone: { command: 'repo' } } })
  }

  const servers = (path: string): string[] =>
    Object.keys((read(path)['mcpServers'] ?? {}) as Record<string, unknown>).sort()

  it('leaves a server out for the role that switched it off, and keeps it for the other', async () => {
    const fx = fixture()
    withServers(fx)
    const svc = service(fx, [], { off: offFor({ workers: ['mcp:figma'] }) })
    const request = { repoPaths: [fx.repo], arcConfigPath: fx.arcConfig }
    const worker = await svc.claude({ ...request, role: 'workers' })
    const brain = await svc.claude({ ...request, role: 'brain' })
    expect(servers(worker.mcpConfigPath)).toEqual(['arc', 'repoone', 'trello'])
    expect(servers(brain.mcpConfigPath)).toEqual(['arc', 'figma', 'repoone', 'trello'])
    expect(worker.mcpConfigPath).not.toBe(brain.mcpConfigPath)
  })

  it('keeps arc whatever is off, even a key named like it', async () => {
    const fx = fixture()
    withServers(fx)
    const svc = service(fx, [], { off: offFor({ brain: ['mcp:arc', 'mcp:figma', 'mcp:trello'] }) })
    const files = await svc.claude({
      repoPaths: [fx.repo],
      arcConfigPath: fx.arcConfig,
      role: 'brain'
    })
    expect(servers(files.mcpConfigPath)).toEqual(['arc', 'repoone'])
  })

  it('drops a plugin’s server by its merged name and a repository’s by its own', async () => {
    const fx = fixture()
    withServers(fx)
    const p = plugin('alpha', { mcp: { mcpServers: { spy: { command: 'false' } } } })
    const svc = service(fx, [p], {
      off: offFor({ workers: ['mcp:plugin_alpha_spy', 'mcp:repoone'] })
    })
    const files = await svc.claude({
      repoPaths: [fx.repo],
      arcConfigPath: fx.arcConfig,
      role: 'workers'
    })
    expect(servers(files.mcpConfigPath)).toEqual(['arc', 'figma', 'trello'])
  })

  it('does nothing without a role: probes and listings get everything', async () => {
    const fx = fixture()
    withServers(fx)
    const svc = service(fx, [], { off: offFor({ brain: ['mcp:figma'], workers: ['mcp:figma'] }) })
    const files = await svc.claude({ repoPaths: [fx.repo], arcConfigPath: fx.arcConfig })
    expect(servers(files.mcpConfigPath)).toEqual(['arc', 'figma', 'repoone', 'trello'])
  })

  it('removes the hook events that are off, keeps the others, and has no file when none is left', async () => {
    const fx = fixture()
    write(join(fx.home, '.claude', 'settings.json'), USER_SETTINGS)
    const events = Object.keys(USER_SETTINGS.hooks)
    expect(events.length).toBeGreaterThan(1)
    const [first, ...rest] = events as [string, ...string[]]

    const one = service(fx, [], { off: offFor({ workers: [`hook:${first}`] }) })
    const worker = await one.claude({ repoPaths: [], role: 'workers' })
    expect(Object.keys((read(worker.hooksSettingsPath!)['hooks'] ?? {}) as object)).toEqual(rest)
    const brain = await one.claude({ repoPaths: [], role: 'brain' })
    expect(Object.keys((read(brain.hooksSettingsPath!)['hooks'] ?? {}) as object)).toEqual(events)

    const all = service(fx, [], { off: offFor({ workers: events.map((e) => `hook:${e}`) }) })
    const none = await all.claude({ repoPaths: [], role: 'workers' })
    expect(none.hooksSettingsPath).toBeUndefined()
    expect(existsSync(join(none.mcpConfigPath, '..', 'hooks.settings.json'))).toBe(false)
    expect((await all.claude({ repoPaths: [], role: 'brain' })).hooksSettingsPath).toBeDefined()
  })

  it('applies a changed selection to the next call, with nothing cached', async () => {
    const fx = fixture()
    withServers(fx)
    let off = new Set<string>()
    const svc = service(fx, [], { off: () => off })
    const request = { repoPaths: [fx.repo], arcConfigPath: fx.arcConfig, role: 'workers' as const }
    expect(servers((await svc.claude(request)).mcpConfigPath)).toContain('figma')
    off = new Set(['mcp:figma'])
    expect(servers((await svc.claude(request)).mcpConfigPath)).not.toContain('figma')
    off = new Set()
    expect(servers((await svc.claude(request)).mcpConfigPath)).toContain('figma')
  })

  it('asks the plugin view for the role’s plugins', async () => {
    const fx = fixture()
    const sources = vi.fn(() => Promise.resolve([] as PluginViewSource[]))
    await service(fx, [], { plugins: { sources } }).claude({ repoPaths: ['/r'], role: 'brain' })
    expect(sources).toHaveBeenCalledWith(['/r'], 'brain')
  })
})
