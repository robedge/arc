import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LoadCatalogue, type LoadCatalogueDeps } from '../../../src/main/personal/load-catalogue'
import {
  frontMatterValue,
  listingEntry,
  listingTokens
} from '../../../src/main/personal/load-listing'
import type { PluginViewSource } from '../../../src/main/plugins/plugin-view'
import type { LoadItem } from '../../../src/shared/types/agent-load'
import { useTempDir } from '../helpers/temp-dir'

const dir = useTempDir('arc-load-catalogue-')
const SECRET = 'sk-never-in-the-listing'

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
}

function skill(home: string, folder: string, front: string): void {
  write(join(home, '.claude', 'skills', folder, 'SKILL.md'), `---\n${front}\n---\nBody\n`)
}

function plugin(name: string, files: Record<string, string> = {}): PluginViewSource {
  const installPath = join(dir(), 'cache', name)
  mkdirSync(installPath, { recursive: true })
  for (const [path, text] of Object.entries(files)) write(join(installPath, path), text)
  return { id: `${name}@m`, folder: name, installPath, manifest: { name } }
}

function catalogue(home: string, extra: Partial<LoadCatalogueDeps> = {}): LoadCatalogue {
  return new LoadCatalogue({
    getHome: () => home,
    projectPaths: () => [],
    plugins: { sources: () => Promise.resolve([]) },
    codex: { ready: () => true, servers: () => Promise.resolve({ servers: [], degraded: false }) },
    ...extra
  })
}

const byKey = (items: LoadItem[], key: string): LoadItem | undefined =>
  items.find((i) => i.key === key)

describe('the estimate rule', () => {
  it('counts one line per entry and rounds up characters over four', () => {
    expect(listingEntry('a', undefined)).toBe('a')
    expect(listingEntry('a', 'b')).toBe('a: b')
    // 'ab' + newline = 3 characters -> 1 token; 4 characters -> 1; 5 -> 2
    expect(listingTokens(['ab'])).toBe(1)
    expect(listingTokens(['abc'])).toBe(1)
    expect(listingTokens(['abcd'])).toBe(2)
    expect(listingTokens([])).toBe(0)
  })

  it('reads plain, quoted, folded and literal front matter values', () => {
    expect(frontMatterValue(['description: Plain text'], 'description')).toBe('Plain text')
    expect(frontMatterValue(['description: "Quoted: yes"'], 'description')).toBe('Quoted: yes')
    expect(
      frontMatterValue(['name: x', 'description: >', '  one', '  two', 'other: 1'], 'description')
    ).toBe('one two')
    expect(frontMatterValue(['description: |-', '  a', '', '  b'], 'description')).toBe('a b')
    expect(frontMatterValue(['name: x'], 'description')).toBeUndefined()
  })
})

describe('LoadCatalogue', () => {
  it('lists skills with the size of their name and description', async () => {
    const home = join(dir(), 'home')
    skill(home, 'planning', 'name: planning\ndescription: Plan the work')
    skill(home, 'folded', 'name: folded\ndescription: >\n  first\n  second')
    write(join(home, '.claude', 'skills', 'not-a-skill', 'README.md'), 'x')
    const { items } = await catalogue(home).list()
    const skills = items.filter((i) => i.kind === 'skill')
    expect(skills.map((s) => s.key)).toEqual(['skill:folded', 'skill:planning'])
    expect(byKey(items, 'skill:planning')?.tokens).toBe(listingTokens(['planning: Plan the work']))
    expect(byKey(items, 'skill:folded')?.tokens).toBe(listingTokens(['folded: first second']))
    expect(byKey(items, 'skill:planning')?.detail).toBe('~/.claude/skills')
  })

  it('follows a skill folder that is a link', async () => {
    const home = join(dir(), 'home')
    skill(join(dir(), 'elsewhere'), 'linked', 'name: linked\ndescription: d')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    symlinkSync(
      join(dir(), 'elsewhere', '.claude', 'skills', 'linked'),
      join(home, '.claude', 'skills', 'linked')
    )
    const { items } = await catalogue(home).list()
    expect(byKey(items, 'skill:linked')).toBeDefined()
  })

  it('lists one row per hook event with no size, and never the hook commands', async () => {
    const home = join(dir(), 'home')
    write(join(home, '.claude', 'settings.json'), {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `echo ${SECRET}` }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }],
        Empty: []
      },
      env: { TOKEN: SECRET }
    })
    const result = await catalogue(home).list()
    const hooks = result.items.filter((i) => i.kind === 'hook')
    expect(hooks.map((h) => h.key)).toEqual(['hook:PreToolUse', 'hook:SessionStart'])
    expect(hooks.every((h) => h.tokens === null)).toBe(true)
    expect(hooks[0]?.note).toContain("can't be estimated")
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('lists plugins with their skills, commands and agents counted, and a note for hooks', async () => {
    const home = join(dir(), 'home')
    const alpha = plugin('alpha', {
      'skills/s1/SKILL.md': '---\nname: s1\ndescription: Skill one\n---\n',
      'commands/run.md': '---\ndescription: Run it\n---\n',
      'commands/sub/deep.md': '---\ndescription: Deep one\n---\n',
      'agents/helper.md': '---\nname: helper\ndescription: Helps\n---\n',
      'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [] }] } })
    })
    const beta = plugin('beta')
    const { items } = await catalogue(home, {
      plugins: { sources: () => Promise.resolve([alpha, beta]) }
    }).list()
    const a = byKey(items, 'plugin:alpha@m')
    expect(a?.label).toBe('alpha')
    expect(a?.detail).toBe('alpha@m')
    expect(a?.tokens).toBe(
      listingTokens([
        's1: Skill one',
        'alpha:run: Run it',
        'alpha:sub:deep: Deep one',
        'helper: Helps'
      ])
    )
    expect(a?.note).toContain('hooks')
    expect(byKey(items, 'plugin:beta@m')?.tokens).toBe(0)
    expect(byKey(items, 'plugin:beta@m')?.note).toBeUndefined()
  })

  it('lists MCP servers of the user, a project, a repository file and a plugin, without their settings', async () => {
    const home = join(dir(), 'home')
    const repo = join(dir(), 'repos', 'api')
    mkdirSync(repo, { recursive: true })
    write(join(home, '.claude.json'), {
      mcpServers: { figma: { command: 'figma', env: { TOKEN: SECRET } } },
      projects: { [repo]: { mcpServers: { localone: { command: 'x' } } } }
    })
    write(join(repo, '.mcp.json'), {
      mcpServers: { repoone: { url: 'http://x', headers: { A: SECRET } } }
    })
    const withMcp = plugin('alpha', {
      '.mcp.json': { mcpServers: { spy: { command: 'false' } } } as never
    })
    const result = await catalogue(home, {
      projectPaths: () => [repo],
      plugins: { sources: () => Promise.resolve([withMcp]) }
    }).list()
    const mcp = result.items.filter((i) => i.kind === 'mcp')
    expect(mcp.map((m) => m.key).sort()).toEqual([
      'mcp:figma',
      'mcp:localone',
      'mcp:plugin_alpha_spy',
      'mcp:repoone'
    ])
    expect(byKey(result.items, 'mcp:figma')?.detail).toBe('Your servers')
    expect(byKey(result.items, 'mcp:localone')?.detail).toBe('Your servers in api')
    expect(byKey(result.items, 'mcp:repoone')?.detail).toBe('.mcp.json in api')
    expect(byKey(result.items, 'mcp:plugin_alpha_spy')?.detail).toBe('Plugin alpha')
    expect(mcp.every((m) => m.tokens === null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain(SECRET)
  })

  it('sizes a server from the tool names an agent reported, and says it counts names only', async () => {
    const home = join(dir(), 'home')
    write(join(home, '.claude.json'), {
      mcpServers: { figma: { command: 'f' }, idle: { command: 'i' } }
    })
    const { items } = await catalogue(home, {
      knownTools: () => new Map([['figma', ['read', 'write']]])
    }).list()
    expect(byKey(items, 'mcp:figma')?.tokens).toBe(
      listingTokens(['mcp__figma__read', 'mcp__figma__write'])
    )
    expect(byKey(items, 'mcp:figma')?.note).toBe('Tool names only')
    expect(byKey(items, 'mcp:idle')?.tokens).toBeNull()
  })

  it('lists Codex servers when Codex is ready, and says why not otherwise', async () => {
    const home = join(dir(), 'home')
    const ready = await catalogue(home, {
      codex: {
        ready: () => true,
        servers: () =>
          Promise.resolve({ servers: [{ name: 'figma', approvalTools: [] }], degraded: false })
      }
    }).listCodex()
    expect(ready.state).toBe('ok')
    expect(byKey(ready.items, 'codex-mcp:figma')).toMatchObject({ kind: 'codex-mcp', tokens: null })

    const missing = await catalogue(home, {
      codex: { ready: () => false, servers: () => Promise.reject(new Error('never asked')) }
    }).listCodex()
    expect(missing).toEqual({ state: 'unavailable', items: [] })

    const broken = await catalogue(home, {
      codex: { ready: () => true, servers: () => Promise.resolve({ servers: [], degraded: true }) }
    }).listCodex()
    expect(broken.state).toBe('unreadable')
  })

  it('never starts Codex for the Claude listing', async () => {
    const asked = vi.fn(() => Promise.reject(new Error('never asked')))
    const result = await catalogue(join(dir(), 'nothing'), {
      codex: { ready: () => true, servers: asked }
    }).list()
    expect(result).toEqual({ items: [] })
    expect(asked).not.toHaveBeenCalled()
  })

  it('returns an empty list for an empty home', async () => {
    expect(await catalogue(join(dir(), 'nothing')).list()).toEqual({ items: [] })
    expect(await catalogue(join(dir(), 'nothing')).listCodex()).toEqual({ items: [], state: 'ok' })
  })
})
