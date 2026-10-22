import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BypassDetector } from '../../../src/main/personal/bypass-detector'
import type { PluginViewSource } from '../../../src/main/plugins/plugin-view'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-bypass-')

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

const hook = (command: string): unknown => [{ hooks: [{ type: 'command', command }] }]

function plugin(
  folder: string,
  hooks: Record<string, unknown> | undefined,
  manifest: Record<string, unknown> = {}
): PluginViewSource {
  const installPath = join(dir(), 'plugins', folder)
  if (hooks) writeJson(join(installPath, 'hooks', 'hooks.json'), { hooks })
  return { id: `${folder}@m`, folder, installPath, manifest }
}

describe('Claude hook events that can skip the permission prompt', () => {
  it('lists PreToolUse and PermissionRequest from the user settings, and not the events that cannot allow', async () => {
    const home = join(dir(), 'home')
    writeJson(join(home, '.claude', 'settings.json'), {
      permissions: { allow: ['Bash(git push:*)'] },
      hooks: {
        PreToolUse: hook('/secret/path/guard.sh'),
        SessionStart: hook('echo hi'),
        PermissionRequest: [],
        Stop: hook('say done')
      }
    })
    const report = await new BypassDetector({
      getHome: () => home,
      getCodexHome: () => join(home, '.codex')
    }).detect()
    expect(report.claudeHookEvents).toEqual(['PreToolUse'])
  })

  it('adds the events of enabled plugins: hooks/hooks.json, an inline manifest object and a manifest path', async () => {
    const home = join(dir(), 'home')
    const byFile = plugin('a', { PermissionRequest: hook('x') })
    const inline = plugin('b', undefined, { hooks: { PreToolUse: hook('y') } })
    const viaPath = plugin('c', undefined, { hooks: './extra/hooks.json' })
    writeJson(join(viaPath.installPath, 'extra', 'hooks.json'), {
      hooks: { PreToolUse: hook('z') }
    })
    const harmless = plugin('d', { SessionStart: hook('w') })
    const sources = vi.fn(() => Promise.resolve([byFile, inline, viaPath, harmless]))
    const report = await new BypassDetector({
      getHome: () => home,
      getCodexHome: () => join(home, '.codex'),
      plugins: { sources }
    }).detect(['/repo'])
    expect(sources).toHaveBeenCalledWith(['/repo'], 'brain')
    expect(sources).toHaveBeenCalledWith(['/repo'], 'workers')
    expect(report.claudeHookEvents).toEqual(['PreToolUse', 'PermissionRequest'])
  })

  it('reports nothing for no settings and no plugins', async () => {
    const home = join(dir(), 'empty')
    expect(
      await new BypassDetector({
        getHome: () => home,
        getCodexHome: () => join(home, '.codex')
      }).detect()
    ).toEqual({
      claudeHookEvents: [],
      claudeHookEventsByRole: { brain: [], workers: [] },
      codexAllowPrefixes: [],
      codexRulesCovered: 0,
      cursor: { allowEntries: [], hookEvents: [] }
    })
  })
})

describe('the selection per role (spec 009)', () => {
  const settingsWith = (home: string): void =>
    writeJson(join(home, '.claude', 'settings.json'), {
      hooks: { PreToolUse: hook('guard.sh'), PermissionRequest: hook('ask.sh') }
    })
  const offFor =
    (selection: Partial<Record<'brain' | 'workers', string[]>>) =>
    (role: 'brain' | 'workers'): ReadonlySet<string> =>
      new Set(selection[role] ?? [])
  const detector = (home: string, extra: ConstructorParameters<typeof BypassDetector>[0] = {}) =>
    new BypassDetector({ getHome: () => home, getCodexHome: () => join(home, '.codex'), ...extra })

  it('reports the events per role: the union stays in claudeHookEvents', async () => {
    const home = join(dir(), 'home')
    settingsWith(home)
    const report = await detector(home, {
      off: offFor({ workers: ['hook:PreToolUse'], brain: ['hook:PermissionRequest'] })
    }).detect()
    expect(report.claudeHookEventsByRole).toEqual({
      brain: ['PreToolUse'],
      workers: ['PermissionRequest']
    })
    expect(report.claudeHookEvents).toEqual(['PreToolUse', 'PermissionRequest'])
  })

  it('reports nothing for a role whose hooks are all off, and nothing at all when both are', async () => {
    const home = join(dir(), 'home')
    settingsWith(home)
    const all = ['hook:PreToolUse', 'hook:PermissionRequest']
    const workersOff = await detector(home, { off: offFor({ workers: all }) }).detect()
    expect(workersOff.claudeHookEventsByRole).toEqual({
      brain: ['PreToolUse', 'PermissionRequest'],
      workers: []
    })
    const bothOff = await detector(home, { off: offFor({ workers: all, brain: all }) }).detect()
    expect(bothOff.claudeHookEvents).toEqual([])
    expect(bothOff.claudeHookEventsByRole).toEqual({ brain: [], workers: [] })
  })

  it('takes a plugin’s hooks from that role’s plugin list', async () => {
    const home = join(dir(), 'home')
    const guarded = plugin('guard', { PreToolUse: hook('x') })
    const sources = vi.fn((_paths: readonly string[], role?: 'brain' | 'workers') =>
      Promise.resolve(role === 'workers' ? [] : [guarded])
    )
    const report = await detector(home, { plugins: { sources } }).detect([])
    expect(report.claudeHookEventsByRole).toEqual({ brain: ['PreToolUse'], workers: [] })
  })
})

describe('Codex allow rules that Arc’s own rules do not cover', () => {
  const rules = [
    'prefix_rule(pattern=["git", "push"], decision="allow")',
    'prefix_rule(pattern=["curl", "-L"], decision="allow")',
    'prefix_rule(pattern=["git", "commit"], decision="allow")',
    'prefix_rule(pattern=["cp"], decision="allow")',
    'prefix_rule(pattern=["node", "-e", "const token = \\"sk-secret-value\\"; run(token)"], decision="allow")',
    'prefix_rule(pattern=["rm"], decision="prompt")'
  ].join('\n')

  it('counts the covered ones and lists the rest as prefixes', async () => {
    const codexHome = join(dir(), 'codex')
    mkdirSync(join(codexHome, 'rules'), { recursive: true })
    writeFileSync(join(codexHome, 'rules', 'default.rules'), rules)
    const report = await new BypassDetector({
      getHome: () => dir(),
      getCodexHome: () => codexHome
    }).detect()
    expect(report.codexRulesCovered).toBe(2)
    expect(report.codexAllowPrefixes).toEqual(['git commit', 'cp', 'node -e …'])
  })

  it('carries no hook command and no rule script', async () => {
    const home = join(dir(), 'home')
    const codexHome = join(home, '.codex')
    mkdirSync(join(codexHome, 'rules'), { recursive: true })
    writeFileSync(join(codexHome, 'rules', 'default.rules'), rules)
    writeJson(join(home, '.claude', 'settings.json'), {
      hooks: { PreToolUse: hook('/secret/path/guard.sh --token abc123') }
    })
    const text = JSON.stringify(
      await new BypassDetector({ getHome: () => home, getCodexHome: () => codexHome }).detect()
    )
    expect(text).not.toContain('guard.sh')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('sk-secret-value')
  })

  it('reads the real CODEX_HOME from the environment when no folder is given', async () => {
    const codexHome = join(dir(), 'env-codex')
    mkdirSync(join(codexHome, 'rules'), { recursive: true })
    writeFileSync(
      join(codexHome, 'rules', 'x.rules'),
      'prefix_rule(pattern=["ls"], decision="allow")'
    )
    const saved = process.env['CODEX_HOME']
    process.env['CODEX_HOME'] = codexHome
    try {
      const report = await new BypassDetector({ getHome: () => dir() }).detect()
      expect(report.codexAllowPrefixes).toEqual(['ls'])
    } finally {
      if (saved === undefined) delete process.env['CODEX_HOME']
      else process.env['CODEX_HOME'] = saved
    }
  })
})

describe('Cursor settings that can skip the permission prompt', () => {
  const detect = (home: string, repos: string[] = []): ReturnType<BypassDetector['detect']> =>
    new BypassDetector({ getHome: () => home, getCodexHome: () => join(home, '.codex') }).detect(
      repos
    )

  it('lists Shell, Write and Mcp allow entries, and leaves the other kinds out', async () => {
    const home = join(dir(), 'home')
    writeJson(join(home, '.cursor', 'cli-config.json'), {
      approvalMode: 'allowlist',
      permissions: {
        allow: ['Shell(ls)', 'Write(src/**)', 'Mcp(github:*)', 'Read(**)', 'WebFetch(example.com)'],
        deny: ['Shell(rm)']
      }
    })
    const { cursor } = await detect(home)
    expect(cursor).toEqual({
      allowEntries: ['Shell(ls)', 'Write(src/**)', 'Mcp(github:*)'],
      hookEvents: []
    })
  })

  it('reports an approvalMode other than allowlist', async () => {
    const home = join(dir(), 'home')
    writeJson(join(home, '.cursor', 'cli-config.json'), {
      approvalMode: 'unrestricted',
      permissions: { allow: [], deny: [] }
    })
    expect((await detect(home)).cursor).toEqual({
      allowEntries: [],
      approvalMode: 'unrestricted',
      hookEvents: []
    })
  })

  it('lists the hook events that can answer allow, from the home and the project hooks.json', async () => {
    const home = join(dir(), 'home')
    const repo = join(dir(), 'repo')
    writeJson(join(home, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: {
        beforeShellExecution: [{ command: './guard.sh' }],
        afterFileEdit: [{ command: 'x' }]
      }
    })
    writeJson(join(repo, '.cursor', 'hooks.json'), {
      version: 1,
      hooks: { preToolUse: [{ command: 'y' }], beforeMCPExecution: [] }
    })
    expect((await detect(home, [repo])).cursor?.hookEvents).toEqual([
      'beforeShellExecution',
      'preToolUse'
    ])
  })

  it("reads the project .cursor/cli.json of the group's projects too", async () => {
    const home = join(dir(), 'home')
    const repo = join(dir(), 'repo')
    writeJson(join(repo, '.cursor', 'cli.json'), { permissions: { allow: ['Shell(npm test)'] } })
    expect((await detect(home, [repo])).cursor?.allowEntries).toEqual(['Shell(npm test)'])
  })

  it('reports nothing for no Cursor files, and never throws on unreadable ones', async () => {
    const home = join(dir(), 'empty')
    expect((await detect(home)).cursor).toEqual({ allowEntries: [], hookEvents: [] })
    mkdirSync(join(home, '.cursor'), { recursive: true })
    writeFileSync(join(home, '.cursor', 'cli-config.json'), '{ not json')
    writeFileSync(join(home, '.cursor', 'hooks.json'), '[]')
    expect((await detect(home)).cursor).toEqual({ allowEntries: [], hookEvents: [] })
  })

  it('never writes: the files are byte-identical afterwards', async () => {
    const home = join(dir(), 'home')
    const file = join(home, '.cursor', 'cli-config.json')
    writeJson(file, { approvalMode: 'unrestricted', permissions: { allow: ['Shell(ls)'] } })
    const before = readFileSync(file, 'utf8')
    await detect(home, [join(dir(), 'no-repo')])
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(join(home, '.cursor', 'hooks.json'))).toBe(false)
  })
})
