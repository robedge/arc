import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { git } from './sessions-rig'

/**
 * Plumbing for the spec 005 acceptance specs: a temporary fake HOME with a fake plugin cache (never the real
 * ~/.claude), repository commands, and the helpers for the message box and the `/` list.
 */

export interface FakePlugin {
  name: string
  marketplace?: string
  version?: string
  description?: string
  /** command name -> description, written to commands/<name>.md */
  commands?: Record<string, string>
  skills?: string[]
  /** Adds hooks/hooks.json (a PostToolUse hook that touches the plugin marker) and a `hooks` key in plugin.json. */
  hooks?: boolean
  /** Adds .mcp.json and an `mcpServers` key in plugin.json. */
  mcp?: boolean
  /** The version the marketplace manifest offers; higher than `version` means "Update available". */
  latest?: string
}

export interface FakeHomeOptions {
  plugins?: FakePlugin[]
  /**
   * A personal PostToolUse hook in ~/.claude/settings.json that touches the `user` marker, next to
   * `permissions` and `env` entries that must never reach an agent.
   */
  userHook?: boolean
  /** A user-scope MCP server `figma` in ~/.claude.json. */
  userMcp?: boolean
  /** Personal commands in ~/.claude/commands (listed as `/user:<name>`): name -> description. */
  userCommands?: Record<string, string>
}

export interface FakeHome {
  home: string
  /** Files the personal and plugin hooks touch when they run. */
  markers: { user: string; plugin: string; repo: string }
  /** The plugin state file the fake CLI's `claude plugin` branch reads and changes. */
  stateFile: string
  /** Environment to pass to `launchRig({ env })`. */
  env: Record<string, string>
  dispose(): Promise<void>
}

const MARKETPLACE = 'fake-market'

function write(path: string, text: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

function hookSettings(command: string): string {
  return JSON.stringify({
    hooks: { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] }
  })
}

export async function makeFakeHome(options: FakeHomeOptions = {}): Promise<FakeHome> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'arc-s8-home-')))
  const markerDir = join(home, 'markers')
  mkdirSync(markerDir)
  const markers = {
    user: join(markerDir, 'user-hook'),
    plugin: join(markerDir, 'plugin-hook'),
    repo: join(markerDir, 'repo-hook')
  }
  const cache = join(home, '.claude', 'plugins', 'cache')
  const state: Record<string, unknown>[] = []
  const manifests = new Map<string, { name: string; version: string }[]>()

  for (const plugin of options.plugins ?? []) {
    const marketplace = plugin.marketplace ?? MARKETPLACE
    const version = plugin.version ?? '1.0.0'
    const dir = join(cache, marketplace, plugin.name, version)
    write(
      join(dir, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: plugin.name,
        version,
        description: plugin.description ?? `The ${plugin.name} plugin`,
        ...(plugin.hooks
          ? { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'false' }] }] } }
          : {}),
        ...(plugin.mcp ? { mcpServers: { spy: { command: 'false' } } } : {})
      })
    )
    for (const [name, description] of Object.entries(plugin.commands ?? {})) {
      write(join(dir, 'commands', `${name}.md`), `---\ndescription: ${description}\n---\nRun.\n`)
    }
    for (const skill of plugin.skills ?? []) {
      write(
        join(dir, 'skills', skill, 'SKILL.md'),
        `---\nname: ${skill}\ndescription: A skill\n---\n`
      )
    }
    if (plugin.hooks) {
      write(join(dir, 'hooks', 'hooks.json'), hookSettings(`touch '${markers.plugin}'`))
    }
    if (plugin.mcp) write(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))
    state.push({
      id: `${plugin.name}@${marketplace}`,
      version,
      scope: 'user',
      enabled: true,
      installPath: dir,
      lastUpdated: '2026-10-01T00:00:00.000Z'
    })
    manifests.set(marketplace, [
      ...(manifests.get(marketplace) ?? []),
      { name: plugin.name, version: plugin.latest ?? version }
    ])
  }
  for (const [marketplace, plugins] of manifests) {
    write(
      join(
        home,
        '.claude',
        'plugins',
        'marketplaces',
        marketplace,
        '.claude-plugin',
        'marketplace.json'
      ),
      JSON.stringify({ name: marketplace, plugins })
    )
  }
  write(
    join(home, '.claude', 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ [MARKETPLACE]: { source: { source: 'github', repo: 'fake/market' } } })
  )
  for (const [name, description] of Object.entries(options.userCommands ?? {})) {
    write(
      join(home, '.claude', 'commands', `${name}.md`),
      `---\ndescription: ${description}\n---\nRun.\n`
    )
  }
  if (options.userHook) {
    write(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        ...JSON.parse(hookSettings(`touch '${markers.user}'`)),
        permissions: { allow: ['Bash(git push:*)'], deny: ['Read(.env)'] },
        env: { PERSONAL_SECRET: 'user-env-secret' }
      })
    )
  }
  if (options.userMcp) {
    write(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { figma: { command: 'figma-mcp', args: ['--stdio'] } } })
    )
  }

  const stateFile = join(home, 'plugins-state.json')
  writeFileSync(stateFile, JSON.stringify(state))
  // Only a built-in: every other command in the `/` list comes from the plugin view and the repositories.
  const commandsFile = join(home, 'commands.json')
  writeFileSync(
    commandsFile,
    JSON.stringify([{ name: 'compact', description: 'Compact the conversation', builtin: true }])
  )

  return {
    home,
    markers,
    stateFile,
    env: {
      HOME: home,
      FAKE_CLAUDE_PLUGINS_JSON: stateFile,
      FAKE_CLAUDE_PLUGIN_CACHE: cache,
      FAKE_CLAUDE_COMMANDS_JSON: commandsFile
    },
    dispose: () => rm(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}

/** Saves a command in a repository (`awos/spec` becomes `/awos:spec`) and commits it on the current branch. */
export function saveRepoCommand(
  repoPath: string,
  file: string,
  description: string,
  extra: Record<string, string> = {}
): void {
  write(
    join(repoPath, '.claude', 'commands', `${file}.md`),
    `---\ndescription: ${description}\n---\nRun.\n`
  )
  for (const [path, text] of Object.entries(extra)) write(join(repoPath, path), text)
  git(repoPath, 'add', '-A')
  git(repoPath, 'commit', '-m', `Save command ${file}`)
}

export const composer = (page: Page): Locator => page.getByLabel('Message to the brain')

export const commandMenu = (page: Page): Locator => page.locator('[data-command-menu]')

/** The list entry for a command, e.g. `/awos:spec`. */
export const commandOption = (page: Page, name: string): Locator =>
  commandMenu(page)
    .getByRole('option')
    .filter({ hasText: new RegExp(`^/${name}(\\s|$)`) })

export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(composer(page)).toHaveValue('')
}

/** Reads the argv of every CLI start in the fake log that runs a session (the probe has no --model). */
export function sessionStarts(log: Record<string, unknown>[]): string[][] {
  return log
    .map((r) => r['argv'])
    .filter((argv): argv is string[] => Array.isArray(argv) && argv.includes('--model'))
}

export function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
