import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CommandCatalogue, type RawCommand } from '../../../src/main/agents/command-probe'
import type { CommandInfo } from '../../../src/shared/types/commands'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-catalogue-')

const USER: RawCommand = { name: 'user:trello', description: 'Trello' }
const PLUGIN: RawCommand = { name: 'superpowers:plan', description: 'Plan' }

function makeRepo(name: string, withCommands = true): string {
  const path = join(dir(), name)
  mkdirSync(join(path, withCommands ? '.claude/commands/awos' : ''), { recursive: true })
  if (withCommands) writeFileSync(join(path, '.claude/commands/awos/spec.md'), 'x')
  return path
}

function makeView(name = 'hash1'): string {
  const view = join(dir(), 'views', name)
  mkdirSync(join(view, 'superpowers'), { recursive: true })
  mkdirSync(join(view, 'user'), { recursive: true })
  return view
}

interface Rig {
  catalogue: CommandCatalogue
  run: ReturnType<typeof vi.fn>
  clock: { now: number }
  view: { dir: string | undefined }
}

function rig(perCwd: (cwd: string) => RawCommand[]): Rig {
  const view = { dir: makeView() as string | undefined }
  const clock = { now: 1000 }
  const run = vi.fn((cwd: string) => Promise.resolve(perCwd(cwd)))
  const catalogue = new CommandCatalogue({
    probe: { run },
    getViewDir: () => Promise.resolve(view.dir),
    now: () => clock.now
  })
  return { catalogue, run, clock, view }
}

describe('CommandCatalogue.invalidate', () => {
  it('probes again after a plugin change even though the cache is fresh', async () => {
    const repo = makeRepo('inv')
    const { catalogue, run } = rig(() => [PLUGIN])
    const request = { repos: [{ name: 'inv', path: repo }], fallbackCwd: dir() }
    await catalogue.list(request)
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(1)
    catalogue.invalidate()
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(2)
  })
})

describe('CommandCatalogue with the personal hooks and MCP files', () => {
  it('probes with the files agents get for that folder, and probes again when they change', async () => {
    const repo = makeRepo('personal')
    const view = makeView()
    let files = { mcpConfigPath: '/ud/agent-config/a/mcp.json' }
    const run = vi.fn<
      (cwd: string, view: string | undefined, personal?: unknown) => Promise<RawCommand[]>
    >(() => Promise.resolve([PLUGIN]))
    const getPersonal = vi.fn<(repos: readonly string[]) => Promise<{ mcpConfigPath: string }>>(
      () => Promise.resolve(files)
    )
    const catalogue = new CommandCatalogue({
      probe: { run },
      getViewDir: () => Promise.resolve(view),
      getPersonal,
      now: () => 1000
    })
    const request = { repos: [{ name: 'personal', path: repo }], fallbackCwd: dir() }
    await catalogue.list(request)
    expect(getPersonal).toHaveBeenCalledWith([repo])
    expect(run).toHaveBeenLastCalledWith(repo, view, files)
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(1)
    files = { mcpConfigPath: '/ud/agent-config/b/mcp.json' }
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenLastCalledWith(repo, view, files)
  })

  it('still probes, without the files, when they cannot be prepared', async () => {
    const repo = makeRepo('nofiles')
    const run = vi.fn<
      (cwd: string, view: string | undefined, personal?: unknown) => Promise<RawCommand[]>
    >(() => Promise.resolve([PLUGIN]))
    const warn = vi.fn()
    const catalogue = new CommandCatalogue({
      probe: { run },
      getViewDir: () => Promise.resolve(makeView()),
      getPersonal: () => Promise.reject(new Error('disk full')),
      log: { warn },
      now: () => 1000
    })
    await catalogue.list({ repos: [{ name: 'nofiles', path: repo }], fallbackCwd: dir() })
    expect(run.mock.calls[0]?.[2]).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('leaves the prompts of MCP servers out of the list', async () => {
    const repo = makeRepo('prompts')
    const { catalogue } = rig(() => [
      PLUGIN,
      { name: 'mcp__figma__design', description: 'Design (MCP)' }
    ])
    const list = await catalogue.list({
      repos: [{ name: 'prompts', path: repo }],
      fallbackCwd: dir()
    })
    expect(list.map((c) => c.name)).toEqual(['superpowers:plan'])
  })
})

describe('CommandCatalogue with Codex entries', () => {
  const codexSkill = {
    id: 'codex:publish-release',
    name: 'publish-release',
    description: 'Publish',
    source: 'codex' as const,
    provider: 'codex' as const,
    kind: 'skill' as const
  }

  function withCodex(entries: CommandInfo[] | Error): {
    catalogue: CommandCatalogue
    codexList: ReturnType<typeof vi.fn>
  } {
    const codexList = vi.fn(() =>
      entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries)
    )
    const catalogue = new CommandCatalogue({
      probe: { run: vi.fn(() => Promise.resolve([USER, PLUGIN])) },
      getViewDir: () => Promise.resolve(makeView()),
      codex: { list: codexList }
    })
    return { catalogue, codexList }
  }

  it('lists Codex skills and prompts after the Claude commands, with provider and kind', async () => {
    const repo = makeRepo('cx')
    const { catalogue, codexList } = withCodex([codexSkill])
    const list = await catalogue.list({
      repos: [{ name: 'cx', path: repo }],
      fallbackCwd: dir(),
      refresh: true
    })
    expect(list.map((c) => [c.id, c.provider, c.kind, c.source])).toEqual([
      ['claude:user:trello', 'claude', 'command', 'user'],
      ['claude:superpowers:plan', 'claude', 'command', 'plugin:superpowers'],
      ['codex:publish-release', 'codex', 'skill', 'codex']
    ])
    expect(codexList).toHaveBeenCalledWith([repo], true)
  })

  it('lists no Codex entries when Codex has none, and survives a Codex list that fails', async () => {
    const repo = makeRepo('cx2')
    const request = { repos: [{ name: 'cx2', path: repo }], fallbackCwd: dir() }
    const none = withCodex([])
    expect((await none.catalogue.list(request)).map((c) => c.provider)).toEqual([
      'claude',
      'claude'
    ])
    const broken = withCodex(new Error('codex down'))
    expect((await broken.catalogue.list(request)).map((c) => c.provider)).toEqual([
      'claude',
      'claude'
    ])
  })

  it('asks Codex in the fallback folder when the session has no repositories', async () => {
    const { catalogue, codexList } = withCodex([codexSkill])
    const brain = join(dir(), 'brain2')
    mkdirSync(brain)
    await catalogue.list({ repos: [], fallbackCwd: brain })
    expect(codexList).toHaveBeenCalledWith([brain], false)
  })
})

describe('CommandCatalogue.list', () => {
  it('merges two repositories: shared entries once, repository entries per repository', async () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const { catalogue, run } = rig((cwd) => [
      USER,
      PLUGIN,
      { name: 'awos:spec', description: `Spec in ${cwd.endsWith('a') ? 'a' : 'b'} (project)` }
    ])
    const list = await catalogue.list({
      repos: [
        { name: 'alpha', path: a },
        { name: 'beta', path: b }
      ],
      fallbackCwd: dir()
    })
    expect(run).toHaveBeenCalledTimes(2)
    expect(list.map((c) => [c.name, c.source, c.description])).toEqual([
      ['user:trello', 'user', 'Trello'],
      ['superpowers:plan', 'plugin:superpowers', 'Plan'],
      ['awos:spec', 'repo:alpha', 'Spec in a'],
      ['awos:spec', 'repo:beta', 'Spec in b']
    ])
  })

  it('probes only repositories with a .claude folder, or one repository when none has', async () => {
    const withClaude = makeRepo('a')
    const bare = makeRepo('bare', false)
    const none1 = join(dir(), 'plain')
    mkdirSync(none1)
    const first = rig(() => [USER])
    await first.catalogue.list({
      repos: [
        { name: 'bare', path: bare },
        { name: 'a', path: withClaude }
      ],
      fallbackCwd: dir()
    })
    expect(first.run.mock.calls.map((c) => c[0])).toEqual([withClaude])

    const second = rig(() => [USER])
    await second.catalogue.list({ repos: [{ name: 'plain', path: none1 }], fallbackCwd: dir() })
    expect(second.run.mock.calls.map((c) => c[0])).toEqual([none1])
  })

  it('probes once in the fallback folder when the session has no repositories', async () => {
    const brain = join(dir(), 'brain')
    mkdirSync(brain)
    const { catalogue, run } = rig(() => [USER, PLUGIN, { name: 'stray', description: 's' }])
    const list = await catalogue.list({ repos: [], fallbackCwd: brain })
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0]?.[0]).toBe(brain)
    expect(list.map((c) => c.name)).toEqual(['user:trello', 'superpowers:plan'])
  })

  it('serves the cache until the commands folder changes', async () => {
    const repo = makeRepo('a')
    const { catalogue, run } = rig(() => [USER])
    const request = { repos: [{ name: 'a', path: repo }], fallbackCwd: dir() }
    await catalogue.list(request)
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(1)

    const file = join(repo, '.claude/commands/awos/spec.md')
    const later = new Date(Date.now() + 60_000)
    utimesSync(file, later, later)
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('probes again when the view hash changes, and after the TTL', async () => {
    const repo = makeRepo('a')
    const { catalogue, run, clock, view } = rig(() => [USER])
    const request = { repos: [{ name: 'a', path: repo }], fallbackCwd: dir() }
    await catalogue.list(request)
    view.dir = makeView('hash2')
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(2)
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(2)
    clock.now += 5 * 60_000 + 1
    await catalogue.list(request)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('refresh ignores a fresh cache', async () => {
    const repo = makeRepo('a')
    const { catalogue, run } = rig(() => [USER])
    const request = { repos: [{ name: 'a', path: repo }], fallbackCwd: dir() }
    await catalogue.list(request)
    await catalogue.list({ ...request, refresh: true })
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('keeps the other repositories when one probe fails, and fails when all do', async () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    const run = vi.fn((cwd: string) =>
      cwd === a ? Promise.reject(new Error('timeout')) : Promise.resolve([USER])
    )
    const warn = vi.fn()
    const catalogue = new CommandCatalogue({
      probe: { run },
      getViewDir: () => Promise.resolve(makeView()),
      log: { warn }
    })
    const both = [
      { name: 'a', path: a },
      { name: 'b', path: b }
    ]
    expect((await catalogue.list({ repos: both, fallbackCwd: dir() })).map((c) => c.name)).toEqual([
      'user:trello'
    ])
    expect(warn).toHaveBeenCalledTimes(1)
    await expect(
      catalogue.list({ repos: [{ name: 'a', path: a }], fallbackCwd: dir() })
    ).rejects.toMatchObject({ code: 'INTERNAL' })
  })

  it('shares one probe between concurrent calls', async () => {
    const repo = makeRepo('a')
    const { catalogue, run } = rig(() => [USER])
    const request = { repos: [{ name: 'a', path: repo }], fallbackCwd: dir() }
    await Promise.all([catalogue.list(request), catalogue.list(request)])
    expect(run).toHaveBeenCalledTimes(1)
  })
})
