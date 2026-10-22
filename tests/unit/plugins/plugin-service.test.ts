import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppErrorException } from '../../../src/shared/errors'
import {
  PluginService,
  RepoSettingsWarner,
  errorText,
  stripAnsi,
  updateFor
} from '../../../src/main/plugins/plugin-service'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-plugin-service-')

interface Setup {
  home: string
  service: PluginService
  /** Writes the fake `claude` (a shell script) and returns nothing. */
  script: (body: string) => void
  bin: string
}

function setup(env: NodeJS.ProcessEnv = {}): Setup {
  const root = dir()
  const home = join(root, 'home')
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true })
  const bin = join(root, 'claude')
  const service = new PluginService({
    resolver: {
      claudeBinary: () => bin,
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? '')
    },
    env: { HOME: home, PATH: process.env['PATH'] ?? '', ...env }
  })
  return {
    home,
    service,
    bin,
    script: (body) => {
      writeFileSync(bin, `#!/bin/sh\n${body}\n`)
      chmodSync(bin, 0o755)
    }
  }
}

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function json(path: string, value: unknown): void {
  write(path, JSON.stringify(value))
}

interface Entry {
  id: string
  version?: string
  scope?: string
  enabled?: boolean
  lastUpdated?: string
  installPath: string
}

/** A `plugin list --json` the fake CLI prints. */
function listOutput(s: Setup, entries: Entry[], wrapped = false): void {
  const rows = entries.map((e) => ({
    scope: 'user',
    enabled: true,
    version: '1.0.0',
    lastUpdated: '2026-01-01T00:00:00Z',
    ...e
  }))
  const file = join(s.home, 'list.json')
  json(file, wrapped ? { installed: rows } : rows)
  s.script(`cat '${file}'`)
}

function plugin(s: Setup, name: string): string {
  return join(s.home, '.claude', 'plugins', 'cache', 'mkt', name, '1.0.0')
}

describe('PluginService.list parsing', () => {
  it('reads an array and an { installed } object, user scope only, deduped by newest lastUpdated', async () => {
    const s = setup()
    const a = plugin(s, 'alpha')
    const aNew = join(s.home, 'alpha-new')
    mkdirSync(a, { recursive: true })
    mkdirSync(aNew, { recursive: true })
    const entries: Entry[] = [
      { id: 'alpha@mkt', version: '1.0.0', installPath: a, lastUpdated: '2026-01-01T00:00:00Z' },
      { id: 'alpha@mkt', version: '1.1.0', installPath: aNew, lastUpdated: '2026-03-01T00:00:00Z' },
      { id: 'proj@mkt', scope: 'project', installPath: a },
      { id: 'off@mkt', enabled: false, installPath: a }
    ]
    for (const wrapped of [false, true]) {
      listOutput(s, entries, wrapped)
      const rows = await s.service.list()
      expect(rows.map((r) => r.id)).toEqual(['alpha@mkt', 'off@mkt'])
      const alpha = rows[0]!
      expect(alpha).toMatchObject({
        name: 'alpha',
        marketplace: 'mkt',
        version: '1.1.0',
        enabled: true
      })
      expect(rows[1]!.enabled).toBe(false)
    }
  })

  it('fails with PLUGIN_FAILED when the output is not a plugin list', async () => {
    const s = setup()
    s.script('echo not-json')
    await expect(s.service.list()).rejects.toMatchObject({ code: 'PLUGIN_FAILED' })
  })
})

describe('PluginService.list details', () => {
  it('takes description and author from plugin.json, else from the marketplace entry', async () => {
    const s = setup()
    const withManifest = plugin(s, 'one')
    const without = plugin(s, 'two')
    json(join(withManifest, '.claude-plugin', 'plugin.json'), {
      name: 'one',
      description: 'From the manifest',
      author: { name: 'Ann' }
    })
    mkdirSync(without, { recursive: true })
    json(join(s.home, '.claude/plugins/marketplaces/mkt/.claude-plugin/marketplace.json'), {
      plugins: [
        { name: 'one', description: 'Entry one' },
        { name: 'two', description: 'Entry two', author: { name: 'Bob' }, version: '1.0.0' }
      ]
    })
    json(join(s.home, '.claude/plugins/known_marketplaces.json'), {
      mkt: { source: { source: 'github', repo: 'acme/plugins' } }
    })
    listOutput(s, [
      { id: 'one@mkt', installPath: withManifest },
      { id: 'two@mkt', installPath: without }
    ])
    const [one, two] = await s.service.list()
    expect(one).toMatchObject({
      description: 'From the manifest',
      author: 'Ann',
      source: 'acme/plugins'
    })
    expect(two).toMatchObject({ description: 'Entry two', author: 'Bob', source: 'acme/plugins' })
  })

  it('counts nested commands, skills with a SKILL.md and flat agents', async () => {
    const s = setup()
    const p = plugin(s, 'counted')
    write(join(p, 'commands', 'a.md'), '#')
    write(join(p, 'commands', 'group', 'b.md'), '#')
    write(join(p, 'commands', 'group', 'deep', 'c.md'), '#')
    write(join(p, 'commands', 'notes.txt'), 'x')
    write(join(p, 'skills', 's1', 'SKILL.md'), '#')
    write(join(p, 'skills', 's2', 'SKILL.md'), '#')
    write(join(p, 'skills', 'no-skill', 'README.md'), '#')
    write(join(p, 'agents', 'x.md'), '#')
    write(join(p, 'agents', 'y.md'), '#')
    listOutput(s, [{ id: 'counted@mkt', installPath: p }])
    const [row] = await s.service.list()
    expect(row!.counts).toEqual({ commands: 3, skills: 2, agents: 2 })
    expect(row!.hasMcp).toBe(false)
    expect(row!.hasHooks).toBe(false)
  })

  it('flags MCP servers and hooks from files and from the manifest', async () => {
    const s = setup()
    const mcpFile = plugin(s, 'mcpfile')
    const mcpManifest = plugin(s, 'mcpmanifest')
    const hooksDir = plugin(s, 'hooksdir')
    const hooksManifest = plugin(s, 'hooksmanifest')
    write(join(mcpFile, '.mcp.json'), '{}')
    json(join(mcpManifest, '.claude-plugin', 'plugin.json'), {
      mcpServers: { x: { command: 'x' } }
    })
    write(join(hooksDir, 'hooks', 'hooks.json'), '{}')
    json(join(hooksManifest, '.claude-plugin', 'plugin.json'), { hooks: { Stop: [] } })
    listOutput(s, [
      { id: 'mcpfile@mkt', installPath: mcpFile },
      { id: 'mcpmanifest@mkt', installPath: mcpManifest },
      { id: 'hooksdir@mkt', installPath: hooksDir },
      { id: 'hooksmanifest@mkt', installPath: hooksManifest }
    ])
    const rows = Object.fromEntries((await s.service.list()).map((r) => [r.name, r]))
    expect([rows['mcpfile']!.hasMcp, rows['mcpmanifest']!.hasMcp]).toEqual([true, true])
    expect([rows['hooksdir']!.hasHooks, rows['hooksmanifest']!.hasHooks]).toEqual([true, true])
    expect([rows['mcpfile']!.hasHooks, rows['hooksdir']!.hasMcp]).toEqual([false, false])
  })
})

describe('update detection', () => {
  it('flags a newer marketplace version through the marketplace manifest', async () => {
    const s = setup()
    const newer = plugin(s, 'newer')
    const same = plugin(s, 'same')
    const unknown = plugin(s, 'unknown')
    mkdirSync(newer, { recursive: true })
    mkdirSync(same, { recursive: true })
    mkdirSync(unknown, { recursive: true })
    json(join(s.home, '.claude/plugins/marketplaces/mkt/.claude-plugin/marketplace.json'), {
      plugins: [
        { name: 'newer', version: '1.10.0' },
        { name: 'same', version: '1.0.0' },
        { name: 'unknown' }
      ]
    })
    listOutput(s, [
      { id: 'newer@mkt', version: '1.9.0', installPath: newer },
      { id: 'same@mkt', version: '1.0.0', installPath: same },
      { id: 'unknown@mkt', version: '1.0.0', installPath: unknown }
    ])
    const rows = Object.fromEntries((await s.service.list()).map((r) => [r.name, r]))
    expect(rows['newer']!.updateAvailable).toBe('1.10.0')
    expect(rows['same']!.updateAvailable).toBeUndefined()
    expect(rows['unknown']!.updateAvailable).toBeUndefined()
  })

  it('compares sha-like versions by prefix', async () => {
    const s = setup()
    const behind = plugin(s, 'behind')
    const current = plugin(s, 'current')
    mkdirSync(behind, { recursive: true })
    mkdirSync(current, { recursive: true })
    json(join(s.home, '.claude/plugins/marketplaces/mkt/.claude-plugin/marketplace.json'), {
      plugins: [
        {
          name: 'behind',
          source: { source: 'url', url: 'u', sha: 'bbbbbbbbbbbb1111111111111111111111111111' }
        },
        {
          name: 'current',
          source: { source: 'url', url: 'u', sha: 'aaaaaaaaaaaa2222222222222222222222222222' }
        }
      ]
    })
    listOutput(s, [
      { id: 'behind@mkt', version: 'aaaaaaaaaaaa', installPath: behind },
      { id: 'current@mkt', version: 'aaaaaaaaaaaa', installPath: current }
    ])
    const rows = Object.fromEntries((await s.service.list()).map((r) => [r.name, r]))
    expect(rows['behind']!.updateAvailable).toBe('bbbbbbbbbbbb')
    expect(rows['current']!.updateAvailable).toBeUndefined()
  })

  it('uses the recorded commit when the installed version is a number and the entry has only a sha', () => {
    const entry = { name: 'p', source: { sha: 'ccccccccccccdddd' } }
    expect(updateFor('1.0.0', entry, 'cccccccccccc')).toBeUndefined()
    expect(updateFor('1.0.0', entry, 'eeeeeeeeeeeeffff')).toBe('cccccccccccc')
    expect(updateFor('1.0.0', entry, undefined)).toBeUndefined()
  })

  it('gives no flag without a comparable version', () => {
    expect(updateFor('1.0.0', undefined, undefined)).toBeUndefined()
    expect(updateFor('1.0.0', { name: 'p' }, undefined)).toBeUndefined()
    expect(updateFor('abc', { version: 'xyz' }, undefined)).toBeUndefined()
    // A sha install against a semver entry cannot be compared.
    expect(updateFor('ddbd034ca35c', { version: '2.0.0' }, undefined)).toBeUndefined()
    expect(updateFor('1.2.3', { version: '1.2.3' }, undefined)).toBeUndefined()
    expect(updateFor('1.2.3', { version: '1.2.2' }, undefined)).toBeUndefined()
    expect(updateFor('1.2', { version: '1.2.1' }, undefined)).toBe('1.2.1')
  })
})

describe('error mapping', () => {
  const reasonOf = async (s: Setup): Promise<string | undefined> => {
    const error = await s.service.run(['x'], { timeoutMs: 5000 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppErrorException)
    expect((error as AppErrorException).code).toBe('PLUGIN_FAILED')
    return (error as AppErrorException).details?.reason
  }

  it('uses the JSON error of a failing exit, then message', async () => {
    const s = setup()
    s.script(`echo '{"error":"Plugin not found"}'; echo ignored >&2; exit 1`)
    expect(await reasonOf(s)).toBe('Plugin not found')
    s.script(`echo '{"message":"Nope"}'; exit 1`)
    expect(await reasonOf(s)).toBe('Nope')
  })

  it('falls back to trimmed stderr, then stdout, with ANSI stripped', async () => {
    const s = setup()
    s.script(`printf '\\033[31m  red failure \\033[0m\\n' >&2; exit 2`)
    expect(await reasonOf(s)).toBe('red failure')
    s.script(`echo 'plain stdout'; exit 2`)
    expect(await reasonOf(s)).toBe('plain stdout')
  })

  it('caps the message at 2 KB', async () => {
    const s = setup()
    s.script(`head -c 5000 /dev/zero | tr '\\0' 'x' >&2; exit 1`)
    expect((await reasonOf(s))?.length).toBe(2048)
  })

  it('strips ANSI sequences and prefers JSON in errorText', () => {
    expect(stripAnsi('\u001b[1mbold\u001b[0m')).toBe('bold')
    expect(errorText('{"error":"\u001b[31mx\u001b[0m"}', 'err')).toBe('x')
    expect(errorText('', ' err ')).toBe('err')
  })

  it('reports a missing binary', async () => {
    const s = setup()
    expect(await reasonOf(s)).toBeTruthy()
  })
})

describe('execution', () => {
  it('passes a limited environment', async () => {
    const s = setup({ ANTHROPIC_API_KEY: 'secret', FAKE_CLAUDE_X: '1', USER: 'tester' })
    const out = join(s.home, 'env.txt')
    s.script(`env | sort > '${out}'; echo '[]'`)
    await s.service.run(['list'], { timeoutMs: 5000 })
    const lines = readFileSync(out, 'utf8').split('\n')
    const keys = lines.map((l) => l.split('=')[0])
    expect(keys).toEqual(expect.arrayContaining(['HOME', 'PATH', 'USER', 'GIT_TERMINAL_PROMPT']))
    expect(lines).toContain('GIT_TERMINAL_PROMPT=0')
    expect(keys).not.toContain('ANTHROPIC_API_KEY')
    expect(keys).not.toContain('FAKE_CLAUDE_X')
  })

  it('passes FAKE_CLAUDE_* only in e2e mode', async () => {
    const s = setup({ HARNESS_E2E: '1', FAKE_CLAUDE_X: '1' })
    const out = join(s.home, 'env.txt')
    s.script(`env > '${out}'; echo '[]'`)
    await s.service.run(['list'], { timeoutMs: 5000 })
    expect(readFileSync(out, 'utf8')).toContain('FAKE_CLAUDE_X=1')
  })

  it('kills the whole process group on a timeout', async () => {
    const s = setup()
    const pidFile = join(s.home, 'child.pid')
    s.script(`sleep 30 &\necho $! > '${pidFile}'\nwait`)
    const error = await s.service.run(['list'], { timeoutMs: 300 }).catch((e: unknown) => e)
    expect((error as AppErrorException).code).toBe('PLUGIN_FAILED')
    expect((error as AppErrorException).details?.reason).toMatch(/did not finish/)
    expect(existsSync(pidFile)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await new Promise((r) => setTimeout(r, 200))
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  })
})

describe('RepoSettingsWarner', () => {
  const repos = [{ name: 'api', path: '/repos/api' }]

  it('logs one event with the right text, once per repository per session', async () => {
    const events: [string, string][] = []
    const warner = new RepoSettingsWarner({
      warnings: () => Promise.resolve({ hooks: true, enabledPlugins: [] })
    })
    const log = (kind: string, text: string): void => void events.push([kind, text])
    await warner.check('s1', repos, log)
    await warner.check('s1', repos, log)
    expect(events).toEqual([
      ['repo-settings', 'api has its own Claude Code settings: its hooks will run in workers.']
    ])
    await warner.check('s2', repos, log)
    expect(events).toHaveLength(2)
  })

  it('words the warning after what the repository has', async () => {
    const cases: [boolean, string[], string][] = [
      [true, [], 'api has its own Claude Code settings: its hooks will run in workers.'],
      [
        false,
        ['x@y'],
        'api has its own Claude Code settings: the plugins it turns on run in workers without their hooks.'
      ],
      [
        true,
        ['x@y'],
        'api has its own Claude Code settings: its hooks will run in workers, and the plugins it turns on run without their hooks.'
      ]
    ]
    for (const [hooks, enabledPlugins, expected] of cases) {
      const events: string[] = []
      await new RepoSettingsWarner({
        warnings: () => Promise.resolve({ hooks, enabledPlugins })
      }).check('s', repos, (_kind, text) => void events.push(text))
      expect(events).toEqual([expected])
    }
  })

  it('warns for enabled plugins, and stays quiet for plain repositories', async () => {
    const events: string[] = []
    const answers: Record<string, { hooks: boolean; enabledPlugins: string[] }> = {
      '/repos/plugins': { hooks: false, enabledPlugins: ['x@y'] },
      '/repos/plain': { hooks: false, enabledPlugins: [] }
    }
    const warner = new RepoSettingsWarner({
      warnings: (path) => Promise.resolve(answers[path]!)
    })
    await warner.check(
      's',
      [
        { name: 'plugins', path: '/repos/plugins' },
        { name: 'plain', path: '/repos/plain' }
      ],
      (_kind, text) => void events.push(text)
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatch(/^plugins has its own Claude Code settings/)
  })

  it('reads the repository settings file by default', async () => {
    const root = dir()
    json(join(root, 'withhooks', '.claude', 'settings.json'), { hooks: { Stop: [{}] } })
    mkdirSync(join(root, 'plain'), { recursive: true })
    const events: string[] = []
    await new RepoSettingsWarner().check(
      's',
      [
        { name: 'withhooks', path: join(root, 'withhooks') },
        { name: 'plain', path: join(root, 'plain') }
      ],
      (_kind, text) => void events.push(text)
    )
    expect(events).toHaveLength(1)
  })
})
