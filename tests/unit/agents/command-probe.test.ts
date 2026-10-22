import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CommandProbe,
  buildProbeArgs,
  mapCommand,
  parseProbeLine,
  type RawCommand
} from '../../../src/main/agents/command-probe'
import { ProcessSupervisor } from '../../../src/main/agents/process-supervisor'
import { useTempDir } from '../helpers/temp-dir'

const child = resolve('tests/unit/agents/helpers/probe-child.mjs')
const fake = resolve('tests/e2e/fixtures/fake-claude.mjs')
const dir = useTempDir('arc-probe-')

const raw = [
  { name: 'compact', description: 'Clear history', builtin: true },
  { name: 'awos:spec', description: 'Creates the spec (project)', argumentHint: '[x]' },
  { name: 'no-hint', description: 'Plain', builtin: false }
]

function probeFor(
  mode: string,
  commands: unknown[] = raw,
  extra: Partial<ConstructorParameters<typeof CommandProbe>[0]> = {}
): { probe: CommandProbe; supervisor: ProcessSupervisor } {
  const supervisor = new ProcessSupervisor()
  const probe = new CommandProbe({
    supervisor,
    binary: process.execPath,
    binaryArgs: [child, mode],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    extraEnv: { ELECTRON_RUN_AS_NODE: '1', PROBE_COMMANDS: JSON.stringify(commands) },
    ...extra
  })
  return { probe, supervisor }
}

describe('parseProbeLine', () => {
  it('skips hook lines and other responses and reads the matching control_response', () => {
    const lines = [
      '{"type":"system","subtype":"hook_started","hook_name":"SessionStart:startup"}',
      '{"type":"system","subtype":"hook_response","exit_code":0}',
      'not json at all',
      '{"type":"control_response","response":{"subtype":"success","request_id":"other","response":{"commands":[]}}}',
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'r1', response: { commands: raw } }
      })
    ]
    const results = lines.map((l) => parseProbeLine(l, 'r1'))
    expect(results.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined])
    expect(results[4]).toEqual({
      kind: 'commands',
      commands: [
        { name: 'awos:spec', description: 'Creates the spec (project)', argumentHint: '[x]' },
        { name: 'no-hint', description: 'Plain' }
      ]
    })
  })

  it('reports an error answer', () => {
    const line = JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'r1', error: 'bad' }
    })
    expect(parseProbeLine(line, 'r1')).toEqual({ kind: 'error', message: 'bad' })
  })
})

describe('mapCommand', () => {
  const pluginNames = new Set(['superpowers', 'awos-plugin'])
  const map = (name: string, projectName: string | null = 'api', description = 'd'): unknown =>
    mapCommand({ name, description }, { pluginNames, projectName })

  it('maps a user: prefix to the user source', () => {
    expect(map('user:agent-browser')).toMatchObject({ name: 'user:agent-browser', source: 'user' })
  })

  it('maps a plugin prefix of the current view to plugin:<name>', () => {
    expect(map('superpowers:brainstorming')).toMatchObject({ source: 'plugin:superpowers' })
  })

  it('maps anything else to the repository and strips a trailing (project)', () => {
    expect(map('awos:spec', 'api', 'Creates the Functional Spec (project)')).toEqual({
      id: 'claude:awos:spec',
      provider: 'claude',
      kind: 'command',
      name: 'awos:spec',
      description: 'Creates the Functional Spec',
      source: 'repo:api'
    })
    expect(map('fix-lint', 'api', 'Fix lint')).toMatchObject({ source: 'repo:api' })
  })

  it('keeps the argument hint and does not strip (project) from user entries', () => {
    expect(
      mapCommand(
        { name: 'user:x', description: 'Mine (project)', argumentHint: '[a]' },
        { pluginNames, projectName: 'api' }
      )
    ).toEqual({
      id: 'claude:user:x',
      provider: 'claude',
      kind: 'command',
      name: 'user:x',
      description: 'Mine (project)',
      argumentHint: '[a]',
      source: 'user'
    })
  })

  it('drops a repository command when there is no repository', () => {
    expect(map('fix-lint', null)).toBeUndefined()
  })
})

describe('CommandProbe', () => {
  it('builds the no-model argv', () => {
    expect(buildProbeArgs('/view/abc')).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--strict-mcp-config',
      '--plugin-dir',
      '/view/abc'
    ])
    expect(buildProbeArgs(undefined)).not.toContain('--plugin-dir')
  })

  it('uses the same personal flags as the agents: the hooks-only --settings file and the merged --mcp-config', () => {
    const args = buildProbeArgs('/view/abc', {
      hooksSettingsPath: '/ud/agent-config/h/hooks.settings.json',
      mcpConfigPath: '/ud/agent-config/h/mcp.json'
    })
    expect(args).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      'project',
      '--settings',
      '/ud/agent-config/h/hooks.settings.json',
      '--mcp-config=/ud/agent-config/h/mcp.json',
      '--strict-mcp-config',
      '--plugin-dir',
      '/view/abc'
    ])
    const bare = buildProbeArgs(undefined, { mcpConfigPath: '/m.json' })
    expect(bare).not.toContain('--settings')
    expect(bare).toContain('--mcp-config=/m.json')
  })

  it('returns the commands when hook lines come first and drops built-ins', async () => {
    const { probe, supervisor } = probeFor('hooks')
    const commands = await probe.run(dir(), undefined)
    expect(commands.map((c: RawCommand) => c.name)).toEqual(['awos:spec', 'no-hint'])
    expect(supervisor.liveCount).toBe(0)
  })

  it('answers through the fake CLI with its default list', async () => {
    const supervisor = new ProcessSupervisor()
    const probe = new CommandProbe({
      supervisor,
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
    })
    const commands = await probe.run(dir(), '/view/abc')
    expect(commands).toEqual([
      {
        name: 'awos:spec',
        description: 'Creates the Functional Spec (project)',
        argumentHint: '[feature, optional]'
      }
    ])
    expect(supervisor.liveCount).toBe(0)
  })

  it('reads the fake CLI list from FAKE_CLAUDE_COMMANDS_JSON', async () => {
    const file = `${dir()}/cmds.json`
    writeFileSync(file, JSON.stringify([{ name: 'user:x', description: 'X' }]))
    const probe = new CommandProbe({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fake],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      env: { HARNESS_E2E: '1', FAKE_CLAUDE_COMMANDS_JSON: file },
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(await probe.run(dir(), undefined)).toEqual([{ name: 'user:x', description: 'X' }])
  })

  it('kills a CLI that does not answer in time', async () => {
    const { probe, supervisor } = probeFor('hang', raw, { timeoutMs: 150, stopGraceMs: 50 })
    await expect(probe.run(dir(), undefined)).rejects.toThrow('did not answer in time')
    expect(supervisor.liveCount).toBe(0)
  })

  it('kills the process group of a CLI that stays alive after answering', async () => {
    const { probe, supervisor } = probeFor('linger', raw, { stopGraceMs: 50 })
    const commands = await probe.run(dir(), undefined)
    expect(commands).toHaveLength(2)
    expect(supervisor.liveCount).toBe(0)
  })

  it('rejects with the CLI error or its stderr', async () => {
    await expect(probeFor('error').probe.run(dir(), undefined)).rejects.toThrow('nope')
    await expect(probeFor('exit1').probe.run(dir(), undefined)).rejects.toThrow(
      'probe child failed'
    )
  })

  it('runs at most the allowed number of probes at once', async () => {
    let live = 0
    let peak = 0
    const supervisor = new ProcessSupervisor()
    const real = supervisor.spawn.bind(supervisor)
    const counting = {
      spawn: (request: Parameters<ProcessSupervisor['spawn']>[0]) => {
        const proc = real(request)
        live += 1
        peak = Math.max(peak, live)
        void proc.exited.then(() => (live -= 1))
        return proc
      }
    }
    const probe = new CommandProbe({
      supervisor: counting,
      binary: process.execPath,
      binaryArgs: [child, 'hooks'],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1', PROBE_COMMANDS: '[]' },
      maxParallel: 2
    })
    await Promise.all([1, 2, 3, 4, 5].map(() => probe.run(dir(), undefined)))
    expect(peak).toBe(2)
  })
})
