import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { AgentHandle } from '../../../src/main/agents/agent-adapter'
import { ClaudeAdapter } from '../../../src/main/agents/claude-adapter'
import { CodexAdapter } from '../../../src/main/agents/codex/codex-adapter'
import { ProcessSupervisor } from '../../../src/main/agents/process-supervisor'
import { McpToolCatalogue } from '../../../src/main/personal/mcp-tool-catalogue'
import { PersonalConfigService } from '../../../src/main/personal/personal-config'

/**
 * `fake-mcp.mjs` (a read-only tool `figma_read`, a tool with no annotation `figma_write`) set up the
 * way a user sets up a server: in a temp HOME's `~/.claude.json`. The agent's own report of its
 * servers decides what runs, with the real adapters talking to the fake CLIs.
 */

const fakeClaude = resolve('tests/e2e/fixtures/fake-claude.mjs')
const fakeCodex = resolve('tests/e2e/fixtures/fake-codex.mjs')
const fakeMcp = resolve('tests/e2e/fixtures/fake-mcp.mjs')
const nodeEnv = { ELECTRON_RUN_AS_NODE: '1' }

let dir: string
const handles: AgentHandle[] = []
let counter = 0
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'arc-mcp-fake-')))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
})

/** The merged `--mcp-config` for a temp HOME whose ~/.claude.json defines the fake server as `fig_ma`. */
async function mergedConfig(extraTools: Record<string, unknown> = {}): Promise<string> {
  const home = join(dir, `home-${++counter}`)
  mkdirSync(home, { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        fig_ma: {
          command: process.execPath,
          args: [fakeMcp],
          env: { ...nodeEnv, FAKE_MCP_TOOLS: JSON.stringify(extraTools) }
        }
      }
    })
  )
  const service = new PersonalConfigService({
    baseDir: join(dir, `agent-config-${counter}`),
    plugins: { sources: () => Promise.resolve([]) },
    getHome: () => home
  })
  return (await service.claude({ repoPaths: [] })).mcpConfigPath
}

async function startClaude(
  mcpConfigPath: string,
  env: Record<string, string> = {},
  mcpStatusMs = 5000
): Promise<AgentHandle> {
  const adapter = new ClaudeAdapter({
    supervisor: new ProcessSupervisor(),
    binary: process.execPath,
    binaryArgs: [fakeClaude],
    resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
    timings: { stopGraceMs: 1000, stopTermMs: 300, mcpStatusMs }
  })
  const handle = await adapter.start({
    provider: 'claude',
    agentId: 'w1',
    role: 'worker',
    cwd: process.cwd(),
    model: 'haiku',
    access: 'worker-write',
    claude: { mcpConfigPath },
    extraEnv: { ...nodeEnv, ...env }
  })
  handles.push(handle)
  return handle
}

describe('a Claude agent with the fake MCP server from a temp HOME', () => {
  it('reports the annotations, and the catalogue runs only the read-only tool', async () => {
    const handle = await startClaude(
      await mergedConfig({ both: { readOnlyHint: true, destructiveHint: true } })
    )
    const servers = await handle.mcpTools?.()
    const fig = servers?.find((s) => s.name === 'fig_ma')
    expect(fig?.connected).toBe(true)
    expect(fig?.tools).toEqual(
      expect.arrayContaining([
        { name: 'figma_read', readOnly: true, destructive: false },
        { name: 'figma_write', readOnly: false, destructive: false },
        { name: 'both', readOnly: true, destructive: true }
      ])
    )

    const catalogue = new McpToolCatalogue()
    catalogue.attachHandle('w1', handle)
    const verdict = async (tool: string): Promise<unknown> =>
      (await catalogue.claudeAction('w1', `mcp__fig_ma__${tool}`, {}))?.['readOnly' as never]
    expect(await verdict('figma_read')).toBe('yes')
    expect(await verdict('figma_write')).toBe('unknown')
    expect(await verdict('both')).toBe('no')
  })

  it('asks for everything when the agent answers mcp_status with an error', async () => {
    const handle = await startClaude(await mergedConfig(), { FAKE_CLAUDE_MCP_STATUS: 'fail' })
    await expect(handle.mcpTools?.()).rejects.toThrow(/could not report/)
    const catalogue = new McpToolCatalogue()
    catalogue.attachHandle('w1', handle)
    expect(await catalogue.claudeAction('w1', 'mcp__fig_ma__figma_read', {})).toMatchObject({
      readOnly: 'unknown'
    })
  })

  it('asks for everything when the agent never answers, after the timeout', async () => {
    const handle = await startClaude(await mergedConfig(), { FAKE_CLAUDE_MCP_STATUS: 'hang' }, 150)
    await expect(handle.mcpTools?.()).rejects.toThrow(/in time/)
    const catalogue = new McpToolCatalogue({ timeoutMs: 150 })
    catalogue.attachHandle('w1', handle)
    expect(await catalogue.claudeAction('w1', 'mcp__fig_ma__figma_read', {})).toMatchObject({
      readOnly: 'unknown'
    })
  })

  it('rejects once the agent has exited', async () => {
    const handle = await startClaude(await mergedConfig())
    await handle.stop()
    await expect(handle.mcpTools?.()).rejects.toThrow(/exited/)
  })
})

describe('a Codex agent', () => {
  it('lists its servers’ tools with the annotations, and the catalogue applies the rule', async () => {
    const adapter = new CodexAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fakeCodex],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: { stopGraceMs: 400, stopTermMs: 300, requestMs: 5000 },
      clientVersion: '9.9.9'
    })
    const handle = await adapter.start({
      provider: 'codex',
      agentId: 'w1',
      role: 'worker',
      cwd: dir,
      model: 'fake-deep',
      access: 'worker-write',
      codex: { personalMcpServers: ['fig_ma'] },
      extraEnv: {
        ...nodeEnv,
        FAKE_CODEX_MCP_TOOLS: JSON.stringify({
          fig_ma: {
            figma_read: { readOnlyHint: true },
            figma_write: {},
            both: { readOnlyHint: true, destructiveHint: true }
          }
        })
      }
    })
    handles.push(handle)
    const servers = await handle.mcpTools?.()
    expect(servers).toEqual([
      {
        name: 'fig_ma',
        connected: true,
        tools: [
          { name: 'figma_read', readOnly: true, destructive: false },
          { name: 'figma_write', readOnly: false, destructive: false },
          { name: 'both', readOnly: true, destructive: true }
        ]
      }
    ])
    const catalogue = new McpToolCatalogue()
    catalogue.attachHandle('w1', handle)
    const covered = new Set(['fig_ma'])
    const read = (tool: string, hint: 'yes' | 'no' | 'unknown'): Promise<unknown> =>
      catalogue.codexAction('w1', { kind: 'mcp', server: 'fig_ma', tool, readOnly: hint }, covered)
    expect(await read('figma_read', 'yes')).toMatchObject({ readOnly: 'yes' })
    expect(await read('both', 'yes')).toMatchObject({ readOnly: 'no' })
    expect(await read('figma_write', 'unknown')).toMatchObject({ readOnly: 'unknown' })
  })

  it('rejects when mcpServerStatus/list fails, and the item’s hint then stands', async () => {
    const adapter = new CodexAdapter({
      supervisor: new ProcessSupervisor(),
      binary: process.execPath,
      binaryArgs: [fakeCodex],
      resolvePath: () => Promise.resolve(process.env['PATH'] ?? ''),
      timings: { stopGraceMs: 400, stopTermMs: 300, requestMs: 5000 },
      clientVersion: '9.9.9'
    })
    const handle = await adapter.start({
      provider: 'codex',
      agentId: 'w2',
      role: 'worker',
      cwd: dir,
      model: 'fake-deep',
      access: 'worker-write',
      codex: {},
      extraEnv: { ...nodeEnv, FAKE_CODEX_MCP_STATUS_FAIL: '1' }
    })
    handles.push(handle)
    await expect(handle.mcpTools?.()).rejects.toThrow(/mcpServerStatus\/list failed/)
    const catalogue = new McpToolCatalogue()
    catalogue.attachHandle('w2', handle)
    const action = {
      kind: 'mcp',
      server: 'fig_ma',
      tool: 'figma_read',
      readOnly: 'yes'
    } as const
    expect(await catalogue.codexAction('w2', action, new Set(['fig_ma']))).toMatchObject({
      readOnly: 'yes'
    })
  })
})
